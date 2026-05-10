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
 * `executeSkill`'s `finally` clause calls `dispose()`. No disk persistence,
 * no cross-run state.
 *
 * MVP limitation: there is no in-process MCP server exposing a `read` tool to
 * the sub-agent, because Pi's `MCPServerSpec` is stdio-command-only and the
 * store lives in the parent process. Retrieval surface is therefore the
 * head/tail preview embedded in the middleware replacement message. A future
 * extension could add a real `context-memory.read` MCP server.
 */

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

  constructor(private readonly settings: ContextMemorySettings) {}

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

    const { preview, elidedChars } = this.makePreview(input.payload);
    return { id, byteLength, preview, elidedChars };
  }

  /** Read a bounded slice. Returns null when the id is unknown. */
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
  }

  private makePreview(payload: string): { preview: string; elidedChars: number } {
    const head = Math.max(0, this.settings.previewHeadBytes | 0);
    const tail = Math.max(0, this.settings.previewTailBytes | 0);
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
