/**
 * Trace cleanup — removal of old execution trace files.
 *
 * Prevents unbounded disk growth in `.pi/traces/`. Called by the router
 * after each trace persist, or manually via the exported helper.
 *
 * Current cleanup strategy (v1.4+): count-based retention per skill.
 * Keeps the last `maxTracesPerSkill` traces per skill and deletes the rest.
 * This auto-tunes to usage — light users' traces live longer because they
 * accumulate slowly; heavy users' traces get pruned more often but the
 * regression window is always full. The default (20) exceeds
 * `regressionWindowSize` (10) so the degradation detector always has enough
 * signal.
 *
 * Legacy TTL-based options are preserved for backward compatibility.
 */

import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TraceCleanupOptions {
  /**
   * Maximum number of trace files to keep per skill (count-based retention).
   * When exceeded for a given skill, oldest files are deleted first.
   * Default: 20.
   */
  maxTracesPerSkill?: number;
  /**
   * Maximum age of a trace file in milliseconds. Files older than this are
   * deleted regardless of skill. 0 = no age-based cleanup.
   * Default: 0 (disabled — count-based retention handles it).
   */
  maxAgeMs?: number;
}

const DEFAULT_MAX_TRACES_PER_SKILL = 20;

/**
 * Extract skill name from a trace filename.
 * Trace files are named `<skillName>_<timestamp>.json`.
 *
 * ⚠️ IMPORTANT: This assumes skill names do NOT contain underscores.
 * By convention, skill names use hyphens (e.g. "plan-feature" not "plan_feature").
 * If a skill name contains underscores, this function will incorrectly
 * truncate at the last underscore, treating the remainder as part of the
 * timestamp. The convention is enforced by the parser's VALID_SKILL_NAME regex
 * which only allows `[a-zA-Z0-9_-]+` — but the underscore is the delimiter here.
 *
 * If this ever becomes a problem, switch to a delimiter like `__` (double
 * underscore) or `--` between name and timestamp.
 */
function extractSkillName(filename: string): string | null {
  if (!filename.endsWith(".json")) return null;
  // Remove .json extension
  const base = filename.slice(0, -5);
  // Split on last underscore (the one before the timestamp)
  const lastUnderscore = base.lastIndexOf("_");
  if (lastUnderscore === -1) return null;
  return base.slice(0, lastUnderscore);
}

/**
 * Remove old trace files from the trace directory using count-based
 * retention per skill.
 *
 * @param traceDirectory - Absolute path to the trace directory.
 * @param opts - Cleanup options.
 * @returns Number of files deleted.
 */
export function cleanupTraces(
  traceDirectory: string,
  opts: TraceCleanupOptions = {}
): number {
  if (!existsSync(traceDirectory)) return 0;

  const maxTracesPerSkill = opts.maxTracesPerSkill ?? DEFAULT_MAX_TRACES_PER_SKILL;
  const maxAgeMs = opts.maxAgeMs ?? 0;
  const now = Date.now();

  // Collect all trace files with their stats, grouped by skill.
  const bySkill = new Map<string, { path: string; mtimeMs: number }[]>();

  for (const entry of readdirSync(traceDirectory)) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(traceDirectory, entry);
    try {
      const stat = statSync(fullPath);
      const skillName = extractSkillName(entry);
      if (!skillName) continue;

      let group = bySkill.get(skillName);
      if (!group) {
        group = [];
        bySkill.set(skillName, group);
      }
      group.push({ path: fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // File disappeared between readdir and stat — skip.
    }
  }

  let deleted = 0;

  // Phase 1: optional age-based cleanup (delete files older than maxAgeMs).
  if (maxAgeMs > 0) {
    for (const files of bySkill.values()) {
      for (let i = files.length - 1; i >= 0; i--) {
        const f = files[i]!;
        if (now - f.mtimeMs > maxAgeMs) {
          try {
            unlinkSync(f.path);
            deleted++;
            files.splice(i, 1);
          } catch {
            // Best-effort.
          }
        }
      }
    }
  }

  // Phase 2: count-based retention per skill.
  // Keep the newest `maxTracesPerSkill` files, delete the rest.
  for (const files of bySkill.values()) {
    if (files.length <= maxTracesPerSkill) continue;

    // Sort oldest first (lowest mtimeMs first).
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    const toDelete = files.length - maxTracesPerSkill;
    for (let i = 0; i < toDelete; i++) {
      const f = files[i]!;
      try {
        unlinkSync(f.path);
        deleted++;
      } catch {
        // Best-effort.
      }
    }
  }

  return deleted;
}
