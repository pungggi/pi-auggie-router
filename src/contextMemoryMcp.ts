/**
 * Standalone MCP server for context-memory access.
 *
 * Spawned as a separate process by pi-auggie-router when context memory is
 * enabled. Reads overflow payloads from a temp directory created by
 * `ContextMemoryStore`. Implements the MCP protocol (JSON-RPC 2.0 over stdio)
 * to expose `context-memory.read` and `context-memory.list` tools to the
 * sub-agent.
 *
 * Usage: node dist/contextMemoryMcp.js <temp-dir>
 *
 * The temp directory contains:
 *   - `manifest.json`: array of ContextMemoryEntry metadata objects
 *   - `<id>.dat`: raw payload text for each stored entry
 *
 * This file has NO imports from the rest of the codebase — it is completely
 * self-contained so it can be spawned as an isolated process.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const inputTempDir = process.argv[2];
if (!inputTempDir) {
  process.stderr.write("Usage: node contextMemoryMcp.js <temp-dir>\n");
  process.exit(1);
}
const tempDir: string = inputTempDir;

// --- Data layer -----------------------------------------------------------

interface ManifestEntry {
  id: string;
  byteLength: number;
  timestamp: number;
  serverName: string;
  toolName: string;
}

const MAX_READ_LIMIT = 32_000;
const OVERFLOW_ID_PATTERN = /^overflow_\d+$/;

function loadManifest(): ManifestEntry[] {
  const manifestPath = join(tempDir, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
}

function readPayload(
  id: string,
  offset: number,
  limit: number
): { content: string; eof: boolean; totalChars: number } | null {
  if (!OVERFLOW_ID_PATTERN.test(id)) return null;
  const filePath = join(tempDir, `${id}.dat`);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const o = Math.max(0, Math.floor(offset));
  const l = Math.min(Math.max(0, Math.floor(limit)), MAX_READ_LIMIT);
  const sliced = content.slice(o, o + l);
  return {
    content: sliced,
    eof: o + l >= content.length,
    totalChars: content.length,
  };
}

// --- MCP protocol ---------------------------------------------------------

const rl = createInterface({ input: process.stdin });

function respond(id: unknown, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id: unknown, code: number, message: string): void {
  const msg = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  process.stdout.write(msg + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: { jsonrpc: string; id?: unknown; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "context-memory", version: "1.0.0" },
      });
      break;
    }

    case "notifications/initialized": {
      // No response required for notifications.
      break;
    }

    case "ping": {
      respond(id, {});
      break;
    }

    case "tools/list": {
      respond(id, {
        tools: [
          {
            name: "context-memory.read",
            description:
              "Read a bounded character-slice of a stored overflow payload. " +
              "Use the `id` from the overflow handle. Returns the content slice, " +
              "whether EOF was reached, and the total character count. " +
              "Maximum slice size is 32 000 characters per call.",
            inputSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Overflow handle, e.g. 'overflow_1'.",
                },
                offset: {
                  type: "number",
                  description:
                    "Character offset to start reading from. Defaults to 0.",
                },
                limit: {
                  type: "number",
                  description:
                    "Maximum characters to read. Defaults to 8000, capped at 32000.",
                },
              },
              required: ["id"],
            },
          },
          {
            name: "context-memory.list",
            description:
              "List all stored overflow entries with metadata (id, byte size, " +
              "source tool, timestamp). Returns an empty array if nothing is stored.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      });
      break;
    }

    case "tools/call": {
      const p = params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      const toolName = p?.name;
      const args = p?.arguments ?? {};

      if (toolName === "context-memory.read") {
        const entryId = args["id"];
        if (typeof entryId !== "string") {
          respondError(id, -32602, "Missing or invalid 'id' argument.");
          break;
        }
        if (!OVERFLOW_ID_PATTERN.test(entryId)) {
          respondError(id, -32602, "Invalid overflow handle.");
          break;
        }
        const result = readPayload(
          entryId,
          (args["offset"] as number) ?? 0,
          (args["limit"] as number) ?? 8000
        );
        if (result) {
          respond(id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        } else {
          respond(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Unknown overflow handle: ${entryId}`,
                }),
              },
            ],
            isError: true,
          });
        }
      } else if (toolName === "context-memory.list") {
        const entries = loadManifest();
        respond(id, {
          content: [{ type: "text", text: JSON.stringify(entries) }],
        });
      } else {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
      }
      break;
    }

    default: {
      if (id !== undefined) {
        respondError(id, -32601, `Unknown method: ${method}`);
      }
      break;
    }
  }
});

rl.on("close", () => {
  process.exit(0);
});
