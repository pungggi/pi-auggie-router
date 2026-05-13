import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { cleanupTraces } from "../src/traceCleanup.ts";

function makeTempDir(): string {
  const dir = join(tmpdir(), `pi-trace-cleanup-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a trace file with the naming convention: `<skillName>_<timestamp>.json`
 * Optionally backdate the file by setting mtime to now - ageMs.
 */
function writeTrace(
  dir: string,
  skillName: string,
  timestampMs: number,
  ageMs: number = 0
): string {
  const filename = `${skillName}_${timestampMs}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify({ skillName }), "utf8");
  if (ageMs > 0) {
    const mtime = new Date(Date.now() - ageMs);
    utimesSync(filepath, mtime, mtime);
  }
  return filepath;
}

describe("cleanupTraces", () => {
  it("enforces maxTracesPerSkill by deleting oldest per skill", () => {
    const dir = makeTempDir();
    try {
      const now = Date.now();
      // 5 traces for skill "alpha" — keep 3, delete 2 oldest
      writeTrace(dir, "alpha", now - 50_000, 50_000);
      writeTrace(dir, "alpha", now - 40_000, 40_000);
      writeTrace(dir, "alpha", now - 30_000, 30_000);
      writeTrace(dir, "alpha", now - 20_000, 20_000);
      writeTrace(dir, "alpha", now - 10_000, 10_000);
      // 1 trace for skill "beta" — keep all
      writeTrace(dir, "beta", now - 5_000, 5_000);

      const deleted = cleanupTraces(dir, { maxTracesPerSkill: 3 });
      assert.equal(deleted, 2);

      const remaining = readdirSync(dir).filter(f => f.endsWith(".json"));
      assert.equal(remaining.length, 4); // 3 alpha + 1 beta
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes files older than maxAgeMs regardless of skill", () => {
    const dir = makeTempDir();
    try {
      const now = Date.now();
      // 8 days old — should be deleted
      writeTrace(dir, "old-skill", now - 8 * 24 * 60 * 60 * 1000, 8 * 24 * 60 * 60 * 1000);
      // 1 day old — should be kept
      writeTrace(dir, "fresh-skill", now - 1 * 24 * 60 * 60 * 1000, 1 * 24 * 60 * 60 * 1000);

      const deleted = cleanupTraces(dir, {
        maxTracesPerSkill: 100,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      });
      assert.equal(deleted, 1);

      const remaining = readdirSync(dir).filter(f => f.endsWith(".json"));
      assert.equal(remaining.length, 1);
      assert.ok(remaining[0].includes("fresh-skill"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 for non-existent directory", () => {
    const deleted = cleanupTraces("/nonexistent/path/12345");
    assert.equal(deleted, 0);
  });

  it("returns 0 when no files need cleanup", () => {
    const dir = makeTempDir();
    try {
      const now = Date.now();
      writeTrace(dir, "skill", now - 1_000, 1_000);
      const deleted = cleanupTraces(dir, { maxTracesPerSkill: 20 });
      assert.equal(deleted, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-JSON files", () => {
    const dir = makeTempDir();
    try {
      const now = Date.now();
      writeTrace(dir, "skill", now, 0);
      // Also write a non-JSON file
      writeFileSync(join(dir, "notes.txt"), "not a trace", "utf8");

      // maxTracesPerSkill = 1, we have 1 trace — nothing deleted
      const deleted = cleanupTraces(dir, { maxTracesPerSkill: 1 });
      assert.equal(deleted, 0);

      const remaining = readdirSync(dir);
      assert.equal(remaining.length, 2); // 1 json + 1 txt
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles files without skill prefix gracefully", () => {
    const dir = makeTempDir();
    try {
      // Write a file that doesn't match <skill>_<timestamp>.json pattern
      writeFileSync(join(dir, "orphan.json"), "{}", "utf8");

      const deleted = cleanupTraces(dir, { maxTracesPerSkill: 1 });
      assert.equal(deleted, 0); // Orphan is not grouped, not deleted
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("independently manages per-skill counts", () => {
    const dir = makeTempDir();
    try {
      const now = Date.now();
      // Skill A: 3 traces
      writeTrace(dir, "skillA", now - 30_000, 30_000);
      writeTrace(dir, "skillA", now - 20_000, 20_000);
      writeTrace(dir, "skillA", now - 10_000, 10_000);
      // Skill B: 3 traces
      writeTrace(dir, "skillB", now - 30_000, 30_000);
      writeTrace(dir, "skillB", now - 20_000, 20_000);
      writeTrace(dir, "skillB", now - 10_000, 10_000);

      // maxTracesPerSkill = 2 → delete 1 from each skill = 2 total
      const deleted = cleanupTraces(dir, { maxTracesPerSkill: 2 });
      assert.equal(deleted, 2);

      const remaining = readdirSync(dir).filter(f => f.endsWith(".json"));
      assert.equal(remaining.length, 4); // 2 per skill
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
