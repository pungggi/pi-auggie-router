/**
 * Action 1 — Overflow Context Memory.
 *
 * Execution-scoped store for oversized Auggie payloads that the overflow
 * middleware would otherwise discard. Each stored entry gets a stable handle
 * (`overflow_1`, `overflow_2`, …) plus a head/tail preview the model can use
 * to decide whether to re-query, refine, or accept the gap.
 *
 * Lifetime is bounded to a single sub-agent execution: the host creates a
 * store before `runSubAgent`, the overflow middleware writes into it, and
 * `executeSkill`'s `finally` clause calls `dispose()`. No disk persistence
 * beyond the temp directory (which `dispose()` deletes).
 *
 * When file-backed storage is active (`tempDir` provided), payloads are also
 * written to disk so a companion MCP server process can serve `read` and
 * `list` tools to the sub-agent.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextMemorySettings } from "./types.js";

export interface ContextMemoryEntry {
  id: string;
  byteLength: number;
  timestamp: number;
  serverName: string;
  toolName: string;
}

export interface ContextMemoryStoreResult {
  id: string;
  byteLength: number;
  preview: string;
  /** Number of chars elided in the head/tail preview, 0 if payload fully shown. */
  elidedChars: number;
}

const PREVIEW_OMITTED_MARKER = "\n... <middle omitted> ...\n";

export class ContextMemoryStore {
  private readonly entries = new Map<
    string,
    { payload: string; meta: ContextMemoryEntry }
  >();
  private totalBytes = 0;
  private counter = 0;
  private disposed = false;

  /**
   * Absolute path to the temp directory used for file-backed storage.
   * When set, payloads are written to `<tempDir>/<id>.dat` and a
   * `manifest.json` is maintained. The companion MCP server reads from
   * this directory. `undefined` when file-backed storage is not active.
   */
  readonly tempDir: string | undefined;

  constructor(
    private readonly settings: ContextMemorySettings,
    fileBacked = false
  ) {
    if (fileBacked && settings.enabled) {
      this.tempDir = join(tmpdir(), `pi-auggie-cm-${randomUUID()}`);
      mkdirSync(this.tempDir, { recursive: true });
      writeFileSync(join(this.tempDir, "manifest.json"), "[]", "utf8");
    }
  }

  /**
   * Persist a payload and return its handle, or `null` if storage is
   * disabled / a limit was hit. Callers should treat `null` as "fall back to
   * the legacy refine-query message" — never throw.
   */
  store(input: {
    payload: string;
    serverName: string;
    toolName: string;
  }): ContextMemoryStoreResult | null {
    if (this.disposed) return null;
    if (!this.settings.enabled) return null;

    const byteLength = Buffer.byteLength(input.payload, "utf8");
    if (this.entries.size >= this.settings.maxEntries) return null;
    if (this.totalBytes + byteLength > this.settings.maxBytesPerRun) return null;

    this.counter++;
    const id = `overflow_${this.counter}`;
    const meta: ContextMemoryEntry = {
      id,
      byteLength,
      timestamp: Date.now(),
      serverName: input.serverName,
      toolName: input.toolName,
    };
    this.entries.set(id, { payload: input.payload, meta });
    this.totalBytes += byteLength;

    // File-backed: write payload to disk and update manifest so the
    // companion MCP server can serve read/list requests.
    if (this.tempDir) {
      try {
        writeFileSync(join(this.tempDir, `${id}.dat`), input.payload, "utf8");
        const manifest = this.list();
        writeFileSync(
          join(this.tempDir, "manifest.json"),
          JSON.stringify(manifest),
          "utf8"
        );
      } catch {
        this.entries.delete(id);
        this.totalBytes -= byteLength;
        this.counter--;
        return null;
      }
    }

    const { preview, elidedChars } = this.makePreview(input.payload);
    return { id, byteLength, preview, elidedChars };
  }

  /**
   * Read a bounded character-slice of a stored payload.
   * Used both internally (e.g. by tests) and as the backing implementation
   * for the `context-memory.read` MCP tool served by the companion process.
   */
  read(
    id: string,
    offset: number,
    limit: number
  ): { content: string; eof: boolean } | null {
    if (this.disposed) return null;
    const entry = this.entries.get(id);
    if (!entry) return null;
    const o = Math.max(0, Math.floor(offset));
    const l = Math.max(0, Math.floor(limit));
    const content = entry.payload.slice(o, o + l);
    const eof = o + l >= entry.payload.length;
    return { content, eof };
  }

  list(): ContextMemoryEntry[] {
    if (this.disposed) return [];
    return Array.from(this.entries.values()).map((e) => ({ ...e.meta }));
  }

  size(): number {
    return this.disposed ? 0 : this.entries.size;
  }

  totalStoredBytes(): number {
    return this.disposed ? 0 : this.totalBytes;
  }

  dispose(): void {
    this.entries.clear();
    this.totalBytes = 0;
    this.disposed = true;
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; OS will reclaim temp files eventually.
      }
    }
  }

  private makePreview(payload: string): { preview: string; elidedChars: number } {
    // Previews operate on character counts (UTF-16 code units) for
    // simplicity. Code/JSON payloads are ASCII-dominant, so bytes ≈ chars in
    // practice. For CJK/emoji-heavy payloads the preview may be slightly
    // larger than the nominal byte budget — an acceptable trade-off.
    const head = Math.max(0, this.settings.previewHeadChars | 0);
    const tail = Math.max(0, this.settings.previewTailChars | 0);
    // If the payload is small enough that head+tail would overlap, just
    // return it whole — no point eliding nothing.
    if (payload.length <= head + tail + PREVIEW_OMITTED_MARKER.length) {
      return { preview: payload, elidedChars: 0 };
    }
    const headPart = head > 0 ? payload.slice(0, head) : "";
    const tailPart = tail > 0 ? payload.slice(payload.length - tail) : "";
    const elidedChars = payload.length - head - tail;
    return {
      preview: `${headPart}${PREVIEW_OMITTED_MARKER}${tailPart}`,
      elidedChars,
    };
  }
}
