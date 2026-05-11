import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { cleanupTraces } from "../src/traceCleanup.ts";

function makeTempDir(): string {
  const dir = join(tmpdir(), `pi-trace-cleanup-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTrace(dir: string, name: string, ageMs: number): string {
  const filepath = join(dir, name);
  writeFileSync(filepath, JSON.stringify({ skillName: "test" }), "utf8");
  // Backdate the file by setting mtime to now - ageMs.
  const mtime = new Date(Date.now() - ageMs);
  const { utimesSync } = require("node:fs");
  utimesSync(filepath, mtime, mtime);
  return filepath;
}

describe("cleanupTraces", () => {
  it("deletes files older than maxAgeMs", () => {
    const dir = makeTempDir();
    try {
      // 8 days old — should be deleted (default TTL = 7 days).
      writeTrace(dir, "old_trace.json", 8 * 24 * 60 * 60 * 1000);
      // 1 day old — should be kept.
      writeTrace(dir, "recent_trace.json", 1 * 24 * 60 * 60 * 1000);

      const deleted = cleanupTraces(dir);
      assert.equal(deleted, 1);

      const remaining = readdirSync(dir).filter(f => f.endsWith(".json"));
      assert.equal(remaining.length, 1);
      assert.ok(remaining[0].includes("recent"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces maxFiles cap by deleting oldest first", () => {
    const dir = makeTempDir();
    try {
      writeTrace(dir, "oldest.json", 5 * 24 * 60 * 60 * 1000);
      writeTrace(dir, "middle.json", 3 * 24 * 60 * 60 * 1000);
      writeTrace(dir, "newest.json", 1 * 24 * 60 * 60 * 1000);

      const deleted = cleanupTraces(dir, { maxAgeMs: Infinity, maxFiles: 2 });
      assert.equal(deleted, 1);

      const remaining = readdirSync(dir).filter(f => f.endsWith(".json"));
      assert.equal(remaining.length, 2);
      assert.ok(remaining.some(f => f.includes("middle")));
      assert.ok(remaining.some(f => f.includes("newest")));
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
      writeTrace(dir, "fresh.json", 1000);
      const deleted = cleanupTraces(dir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxFiles: 100 });
      assert.equal(deleted, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-JSON files", () => {
    const dir = makeTempDir();
    try {
      writeTrace(dir, "old.json", 8 * 24 * 60 * 60 * 1000);
      writeFileSync(join(dir, "old.txt"), "not a trace", "utf8");

      const deleted = cleanupTraces(dir);
      assert.equal(deleted, 1);
      // .txt file should survive.
      const remaining = readdirSync(dir);
      assert.equal(remaining.length, 1);
      assert.ok(remaining[0].endsWith(".txt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
