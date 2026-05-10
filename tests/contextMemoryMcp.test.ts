import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ContextMemoryStore } from "../src/contextMemory.ts";
import { DEFAULT_CONTEXT_MEMORY } from "../src/config.ts";

function settings() {
  return { ...DEFAULT_CONTEXT_MEMORY, enabled: true };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

let built = false;
async function ensureBuilt(): Promise<void> {
  if (built) return;
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile("npm", ["run", "build"], { shell: process.platform === "win32" }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  built = true;
}

class McpHarness {
  private seq = 0;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonRpcResponse) => void; reject: (err: Error) => void }
  >();

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const idx = this.buffer.indexOf("\n");
        if (idx < 0) break;
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    });
    proc.on("error", (err) => {
      for (const waiter of this.pending.values()) waiter.reject(err);
      this.pending.clear();
    });
    proc.on("exit", (code) => {
      const err = new Error(`MCP server exited with code ${code}`);
      for (const waiter of this.pending.values()) waiter.reject(err);
      this.pending.clear();
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = ++this.seq;
    const msg = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    return promise;
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function startServer(tempDir: string): Promise<McpHarness> {
  await ensureBuilt();
  const proc = spawn(process.execPath, ["dist/contextMemoryMcp.js", tempDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new McpHarness(proc);
}

function textPayload(res: JsonRpcResponse): unknown {
  const result = res.result as { content?: Array<{ text?: string }> };
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

describe("contextMemoryMcp server", () => {
  before(async () => {
    await ensureBuilt();
  });

  it("handles initialize and tools/list", async () => {
    const store = new ContextMemoryStore(settings(), true);
    const harness = await startServer(store.tempDir!);
    try {
      const init = await harness.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      assert.equal(init.error, undefined);
      assert.equal(
        (init.result as { serverInfo?: { name?: string } }).serverInfo?.name,
        "context-memory"
      );

      const list = await harness.request("tools/list");
      const tools = (list.result as { tools?: Array<{ name: string }> }).tools ?? [];
      assert.deepEqual(
        tools.map((t) => t.name),
        ["context-memory.read", "context-memory.list"]
      );
    } finally {
      harness.close();
      store.dispose();
    }
  });

  it("lists entries and reads bounded payload slices", async () => {
    const store = new ContextMemoryStore(settings(), true);
    const stored = store.store({
      payload: "abcdefghij",
      serverName: "auggie",
      toolName: "codebase-retrieval",
    })!;
    const harness = await startServer(store.tempDir!);
    try {
      const list = await harness.request("tools/call", {
        name: "context-memory.list",
        arguments: {},
      });
      const entries = textPayload(list) as Array<{ id: string; byteLength: number }>;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.id, stored.id);
      assert.equal(entries[0]!.byteLength, 10);

      const read = await harness.request("tools/call", {
        name: "context-memory.read",
        arguments: { id: stored.id, offset: 2, limit: 4 },
      });
      assert.deepEqual(textPayload(read), {
        content: "cdef",
        eof: false,
        totalChars: 10,
      });

      const tail = await harness.request("tools/call", {
        name: "context-memory.read",
        arguments: { id: stored.id, offset: 8, limit: 10 },
      });
      assert.deepEqual(textPayload(tail), {
        content: "ij",
        eof: true,
        totalChars: 10,
      });
    } finally {
      harness.close();
      store.dispose();
    }
  });

  it("returns a tool error for unknown overflow IDs", async () => {
    const store = new ContextMemoryStore(settings(), true);
    const harness = await startServer(store.tempDir!);
    try {
      const res = await harness.request("tools/call", {
        name: "context-memory.read",
        arguments: { id: "overflow_999" },
      });
      const result = res.result as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.deepEqual(textPayload(res), {
        error: "Unknown overflow handle: overflow_999",
      });
    } finally {
      harness.close();
      store.dispose();
    }
  });

  it("rejects malformed handles before constructing a path", async () => {
    const store = new ContextMemoryStore(settings(), true);
    const harness = await startServer(store.tempDir!);
    try {
      const res = await harness.request("tools/call", {
        name: "context-memory.read",
        arguments: { id: "../manifest" },
      });
      assert.equal(res.result, undefined);
      assert.equal(res.error?.code, -32602);
      assert.match(res.error?.message ?? "", /Invalid overflow handle/);
    } finally {
      harness.close();
      store.dispose();
    }
  });
});
