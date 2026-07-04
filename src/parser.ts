import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { ParsedSkill, PiHost } from "./types.js";

export const SKILL_COMMAND_REGEX = /^\/skill:([a-zA-Z0-9_-]+)\b/;
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

export class SkillNotFoundError extends Error {
  constructor(public readonly skillName: string, public readonly searched: string[]) {
    super(`Skill "${skillName}" not found. Searched: ${searched.join(", ")}`);
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
 * Look up a SKILL.md file in the workspace, then in the user's home dir.
 * Per PRD §2.1 we check `.pi/skills/<name>/SKILL.md` first, then
 * `~/.pi/agent/skills/<name>/SKILL.md`.
 *
 * The `skillName` is validated against `[a-zA-Z0-9_-]+` to close path
 * traversal via the public API (the chat-input regex already enforces
 * this, but `loadSkill` / `locateSkillFile` are exported).
 */
export function locateSkillFile(host: PiHost, skillName: string): string {
  if (!VALID_SKILL_NAME.test(skillName)) {
    throw new InvalidSkillNameError(skillName);
  }
  const candidates = [
    host.resolveWorkspacePath(join(".pi", "skills", skillName, "SKILL.md")),
    host.resolveHomePath(join(".pi", "agent", "skills", skillName, "SKILL.md")),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new SkillNotFoundError(skillName, candidates);
}

export function parseSkillFile(skillName: string, filePath: string): ParsedSkill {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const fmModel = (parsed.data as Record<string, unknown>).model;
  return {
    name: skillName,
    filePath,
    rawModel: typeof fmModel === "string" && fmModel.trim() ? fmModel.trim() : undefined,
    instructions: parsed.content.trim(),
  };
}

export function loadSkill(host: PiHost, skillName: string): ParsedSkill {
  return parseSkillFile(skillName, locateSkillFile(host, skillName));
}

export interface SkillListing {
  name: string;
  filePath: string;
  /** Frontmatter `description:`, if present. */
  description?: string;
  source: "workspace" | "home";
}

function scanSkillRoot(root: string, source: SkillListing["source"]): SkillListing[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: SkillListing[] = [];
  for (const name of entries) {
    if (!VALID_SKILL_NAME.test(name)) continue;
    const filePath = join(root, name, "SKILL.md");
    if (!existsSync(filePath)) continue;
    let description: string | undefined;
    try {
      const fm = matter(readFileSync(filePath, "utf8")).data as Record<string, unknown>;
      if (typeof fm.description === "string" && fm.description.trim()) {
        description = fm.description.trim();
      }
    } catch {
      // A malformed SKILL.md must not break completion; `loadSkill` surfaces
      // the real parse error if the user actually runs the skill.
    }
    out.push({ name, filePath, description, source });
  }
  return out;
}

/**
 * Enumerate every skill visible to the router, in the same precedence order
 * as `locateSkillFile`: workspace skills shadow home skills of the same name.
 */
export function listSkills(host: PiHost): SkillListing[] {
  const all = [
    ...scanSkillRoot(host.resolveWorkspacePath(join(".pi", "skills")), "workspace"),
    ...scanSkillRoot(host.resolveHomePath(join(".pi", "agent", "skills")), "home"),
  ];
  const seen = new Set<string>();
  const out: SkillListing[] = [];
  for (const s of all) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
