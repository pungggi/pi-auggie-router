import { existsSync, readFileSync } from "node:fs";
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
