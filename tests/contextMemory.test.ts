import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextMemoryStore } from "../src/contextMemory.ts";
import { DEFAULT_CONTEXT_MEMORY } from "../src/config.ts";
import type { ContextMemorySettings } from "../src/types.ts";

function settingsWith(
  overrides: Partial<ContextMemorySettings> = {}
): ContextMemorySettings {
  return { ...DEFAULT_CONTEXT_MEMORY, enabled: true, ...overrides };
}

describe("ContextMemoryStore", () => {
  it("returns null when disabled", () => {
    const store = new ContextMemoryStore({ ...DEFAULT_CONTEXT_MEMORY });
    const r = store.store({
      payload: "x".repeat(100),
      serverName: "auggie",
      toolName: "codebase-retrieval",
    });
    assert.equal(r, null);
  });

  it("stores payload and returns a stable, monotonic handle", () => {
    const store = new ContextMemoryStore(settingsWith());
    const a = store.store({
      payload: "alpha",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    });
    const b = store.store({
      payload: "beta",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    });
    assert.equal(a?.id, "overflow_1");
    assert.equal(b?.id, "overflow_2");
    assert.equal(store.size(), 2);
  });

  it("read returns bounded slices and signals eof", () => {
    const store = new ContextMemoryStore(settingsWith());
    const r = store.store({
      payload: "abcdefghij",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    })!;
    const slice = store.read(r.id, 2, 4);
    assert.deepEqual(slice, { content: "cdef", eof: false });
    const tail = store.read(r.id, 6, 10);
    assert.deepEqual(tail, { content: "ghij", eof: true });
  });

  it("read returns null for unknown handle", () => {
    const store = new ContextMemoryStore(settingsWith());
    assert.equal(store.read("overflow_999", 0, 10), null);
  });

  it("enforces maxEntries", () => {
    const store = new ContextMemoryStore(
      settingsWith({ maxEntries: 2, maxBytesPerRun: 1_000_000 })
    );
    const a = store.store({ payload: "a", serverName: "auggie", toolName: "codebase-retrieval" });
    const b = store.store({ payload: "b", serverName: "auggie", toolName: "codebase-retrieval" });
    const c = store.store({ payload: "c", serverName: "auggie", toolName: "codebase-retrieval" });
    assert.ok(a);
    assert.ok(b);
    assert.equal(c, null, "third entry rejected by maxEntries");
    assert.equal(store.size(), 2);
  });

  it("enforces maxBytesPerRun across cumulative payloads", () => {
    const store = new ContextMemoryStore(
      settingsWith({ maxEntries: 100, maxBytesPerRun: 50 })
    );
    const a = store.store({
      payload: "x".repeat(40),
      serverName: "auggie",
      toolName: "codebase-retrieval",
    });
    assert.ok(a);
    const b = store.store({
      payload: "y".repeat(20),
      serverName: "auggie",
      toolName: "codebase-retrieval",
    });
    assert.equal(b, null, "second store would exceed the byte cap");
    assert.equal(store.totalStoredBytes(), 40);
  });

  it("preview returns full payload when small enough", () => {
    const store = new ContextMemoryStore(
      settingsWith({ previewHeadChars: 100, previewTailChars: 100 })
    );
    const r = store.store({
      payload: "tiny",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    })!;
    assert.equal(r.preview, "tiny");
    assert.equal(r.elidedChars, 0);
  });

  it("preview elides middle for large payloads", () => {
    const store = new ContextMemoryStore(
      settingsWith({ previewHeadChars: 5, previewTailChars: 5 })
    );
    const payload = "HEAD_" + "M".repeat(200) + "_TAIL";
    const r = store.store({
      payload,
      serverName: "auggie",
      toolName: "codebase-retrieval",
    })!;
    assert.match(r.preview, /^HEAD_/);
    assert.match(r.preview, /_TAIL$/);
    assert.match(r.preview, /<middle omitted>/);
    assert.ok(r.elidedChars > 0);
    // Preview must be much smaller than the payload.
    assert.ok(r.preview.length < payload.length);
  });

  it("dispose clears entries and rejects further reads", () => {
    const store = new ContextMemoryStore(settingsWith());
    const r = store.store({
      payload: "alpha",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    })!;
    store.dispose();
    assert.equal(store.size(), 0);
    assert.equal(store.read(r.id, 0, 10), null);
    // Storing after dispose is a no-op.
    const post = store.store({
      payload: "x",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    });
    assert.equal(post, null);
  });

  it("list surfaces metadata only — no payload bytes", () => {
    const store = new ContextMemoryStore(settingsWith());
    store.store({
      payload: "secret-data",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    });
    const items = store.list();
    assert.equal(items.length, 1);
    const meta = items[0]!;
    assert.equal(meta.id, "overflow_1");
    assert.equal(meta.serverName, "auggie");
    assert.equal(meta.toolName, "codebase-retrieval");
    assert.equal(meta.byteLength, Buffer.byteLength("secret-data", "utf8"));
    // Make sure we did not surface the payload itself.
    assert.equal((meta as Record<string, unknown>).payload, undefined);
  });

  it("file-backed mode writes payload and manifest, then deletes temp dir on dispose", () => {
    const store = new ContextMemoryStore(settingsWith(), true);
    assert.ok(store.tempDir, "file-backed store exposes tempDir");
    const tempDir = store.tempDir!;
    assert.ok(existsSync(tempDir), "temp directory is created");
    assert.deepEqual(
      JSON.parse(readFileSync(join(tempDir, "manifest.json"), "utf8")),
      []
    );

    const payload = "secret-data";
    const stored = store.store({
      payload,
      serverName: "auggie",
      toolName: "codebase-retrieval",
    })!;

    assert.equal(readFileSync(join(tempDir, `${stored.id}.dat`), "utf8"), payload);
    const manifest = JSON.parse(
      readFileSync(join(tempDir, "manifest.json"), "utf8")
    );
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, stored.id);
    assert.equal(manifest[0].byteLength, Buffer.byteLength(payload, "utf8"));
    assert.equal(manifest[0].payload, undefined);

    store.dispose();
    assert.equal(existsSync(tempDir), false);
  });

  it("does not create a temp directory when disabled even if file-backed requested", () => {
    const store = new ContextMemoryStore({ ...DEFAULT_CONTEXT_MEMORY }, true);
    assert.equal(store.tempDir, undefined);
  });
});
