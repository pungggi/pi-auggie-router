/**
 * Trace cleanup — TTL-based removal of old execution trace files.
 *
 * Prevents unbounded disk growth in `.pi/traces/`. Called by the router
 * after each trace persist, or manually via the exported helper.
 *
 * Cleanup strategy: delete any trace file older than `maxAgeMs`. The
 * default TTL is 7 days. A maximum file count cap ensures that even
 * with high-frequency skill usage, the directory stays bounded.
 */

import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TraceCleanupOptions {
  /** Maximum age of a trace file in milliseconds. Default: 7 days. */
  maxAgeMs?: number;
  /**
   * Maximum number of trace files to keep (globally, across all skills).
   * When exceeded, oldest files are deleted first. 0 = no cap. Default: 500.
   */
  maxFiles?: number;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_FILES = 500;

/**
 * Remove old trace files from the trace directory.
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

  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const now = Date.now();

  // Collect all trace files with their stats.
  const files: { name: string; path: string; mtimeMs: number }[] = [];
  for (const entry of readdirSync(traceDirectory)) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(traceDirectory, entry);
    try {
      const stat = statSync(fullPath);
      files.push({ name: entry, path: fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // File disappeared between readdir and stat — skip.
    }
  }

  // Sort oldest first.
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let deleted = 0;

  // Phase 1: delete files older than maxAgeMs.
  for (const f of files) {
    if (now - f.mtimeMs <= maxAgeMs) break;
    try {
      unlinkSync(f.path);
      deleted++;
    } catch {
      // Best-effort.
    }
  }

  // Phase 2: if still over maxFiles, delete oldest until under cap.
  if (maxFiles > 0) {
    // Re-read remaining files after age-based cleanup.
    const remaining: { path: string; mtimeMs: number }[] = [];
    for (const entry of readdirSync(traceDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const fullPath = join(traceDirectory, entry);
      try {
        const stat = statSync(fullPath);
        remaining.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // skip
      }
    }
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);

    while (remaining.length > maxFiles) {
      const oldest = remaining.shift()!;
      try {
        unlinkSync(oldest.path);
        deleted++;
      } catch {
        // Best-effort.
      }
    }
  }

  return deleted;
}
