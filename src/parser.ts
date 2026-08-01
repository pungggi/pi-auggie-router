import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { ParsedSkill, PiHost, SkillExecutionMode } from "./types.js";

export const SKILL_COMMAND_REGEX = /^\/skill:([a-zA-Z0-9_-]+)\b/;
/**
 * Explicit in-session escape hatch. Both `/skill-local:<name>` and
 * `/skill!<name>` map to the same handler and are NEVER claimed by the
 * router — Pi's built-in skill loader runs them in the main session.
 * Disjoint from `SKILL_COMMAND_REGEX` (neither starts with `/skill:`).
 */
export const LOCAL_SKILL_COMMAND_REGEX = /^\/(?:skill-local:|skill!:)([a-zA-Z0-9_-]+)\b/;
const VALID_SKILL_NAME = /^[a-zA-Z0-9_-]+$/;

export interface SkillCommandMatch {
  name: string;
  /** Whatever the user typed after the command, trimmed. */
  remainder: string;
}

export function matchSkillCommand(input: string): SkillCommandMatch | null {
  const m = SKILL_COMMAND_REGEX.exec(input.trimStart());
  if (!m) return null;
  const name = m[1]!;
  const remainder = input.trimStart().slice(m[0].length).trim();
  return { name, remainder };
}

/**
 * Match the explicit in-session escape hatch (`/skill-local:<name>` or
 * `/skill!<name>`). Returns the captured name + remainder, or `null`.
 * The router uses this to decide to *not* cancel the input so Pi's
 * built-in skill loader handles it in the main session.
 */
export function matchLocalSkillCommand(input: string): SkillCommandMatch | null {
  const m = LOCAL_SKILL_COMMAND_REGEX.exec(input.trimStart());
  if (!m) return null;
  const name = m[1]!;
  const remainder = input.trimStart().slice(m[0].length).trim();
  return { name, remainder };
}

export class SkillNotFoundError extends Error {
  constructor(public readonly skillName: string, public readonly searched: string[]) {
    super(`Skill "${skillName}" not found.`);
    this.name = "SkillNotFoundError";
  }
}

export class InvalidSkillNameError extends Error {
  constructor(public readonly skillName: string) {
    super(
      `Invalid skill name "${skillName}"; must match [a-zA-Z0-9_-]+ (no path separators).`
    );
    this.name = "InvalidSkillNameError";
  }
}

/**
 * Look up a SKILL.md file in the workspace, then in the user's home dir,
 * then in any additional roots the host enumerates (pi's `settings.skills`
 * entries such as `~/.claude/skills`, package-contributed skills, …).
 *
 * Per PRD §2.1 we check `.pi/skills/<name>/SKILL.md` first, then
 * `~/.pi/agent/skills/<name>/SKILL.md`, then each `host.listSkillRoots()`
 * entry (treated as a directory holding `<name>/SKILL.md`).
 *
 * The `skillName` is validated against `[a-zA-Z0-9_-]+` to close path
 * traversal via the public API (the chat-input regex already enforces
 * this, but `loadSkill` / `locateSkillFile` are exported).
 */
export function locateSkillFile(host: PiHost, skillName: string): string {
  if (!VALID_SKILL_NAME.test(skillName)) {
    throw new InvalidSkillNameError(skillName);
  }
  const candidates: string[] = [
    host.resolveWorkspacePath(join(".pi", "skills", skillName, "SKILL.md")),
    host.resolveHomePath(join(".pi", "agent", "skills", skillName, "SKILL.md")),
  ];
  // Discovery parity: also search pi skill roots the host exposes
  // (e.g. `~/.claude/skills`). Each entry is treated as a directory
  // containing `<skillName>/SKILL.md`. Roots are appended as-is — the
  // host is responsible for `~` expansion / absolute resolution.
  const extraRoots = host.listSkillRoots?.() ?? [];
  for (const root of extraRoots) {
    if (typeof root === "string" && root) {
      candidates.push(join(root, skillName, "SKILL.md"));
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new SkillNotFoundError(skillName, candidates);
}

function asBool(val: unknown): boolean | undefined {
  return typeof val === "boolean" ? val : undefined;
}

export function parseSkillFile(skillName: string, filePath: string): ParsedSkill {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const fmModel = data.model;
  const fmExecution = data.execution;
  const execution: SkillExecutionMode | undefined =
    fmExecution === "in-context" || fmExecution === "subagent" ? fmExecution : undefined;
  return {
    name: skillName,
    filePath,
    rawModel: typeof fmModel === "string" && fmModel.trim() ? fmModel.trim() : undefined,
    instructions: parsed.content.trim(),
    execution,
    router: asBool(data.router),
    // Agent Skills standard field is hyphenated in YAML frontmatter.
    disableModelInvocation: asBool(data["disable-model-invocation"]),
  };
}

/**
 * Decide whether a skill should run **in-session** (HITL / manual — Pi's
 * built-in loader) instead of being routed to an isolated sub-agent.
 *
 * Precedence (see `docs/HITL-skill-passthrough.md` §5.2):
 *
 * 1. `execution: in-context` → local
 * 2. `execution: subagent`  → routed (override, even if `disable-model-invocation: true`)
 * 3. `router: false` → local; `router: true` → routed
 * 4. `disable-model-invocation: true` → local
 * 5. else → routed (default; backwards compatible)
 */
export function isLocalExecution(skill: ParsedSkill): boolean {
  if (skill.execution === "in-context") return true;
  if (skill.execution === "subagent") return false;
  if (skill.router === false) return true;
  if (skill.router === true) return false;
  if (skill.disableModelInvocation === true) return true;
  return false;
}

export function loadSkill(host: PiHost, skillName: string): ParsedSkill {
  return parseSkillFile(skillName, locateSkillFile(host, skillName));
}
