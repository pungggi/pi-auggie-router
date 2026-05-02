import { spawn } from "node:child_process";
import type { MCPServerSpec, ToolResultMiddleware } from "./types.js";

export const AUGGIE_MCP_NAME = "auggie";
export const AUGGIE_TOOL_NAME = "codebase-retrieval";

export const AUGGIE_DIRECTIVE =
  "To gather context, you MUST strictly use the MCP tool named " +
  "`codebase-retrieval`. Do not attempt to run auggie in the terminal.";

export interface PreflightResult {
  ok: boolean;
  /** stderr output, useful for surfacing the auth/daemon failure reason. */
  detail: string;
}

/**
 * Per PRD §2.5: silent `auggie status` pre-flight. Resolves with `ok=false`
 * if the binary is missing, exits non-zero, or hangs > 5s.
 */
export function runAuggieStatus(timeoutMs = 5_000): Promise<PreflightResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (res: PreflightResult) => {
      if (resolved) return;
      resolved = true;
      resolve(res);
    };

    let child;
    try {
      child = spawn("auggie", ["status"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ ok: false, detail: (err as Error).message });
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.stdout?.on("data", () => {
      // discard; we only care about exit code
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ ok: false, detail: "auggie status timed out" });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, detail: err.message });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true, detail: "" });
      } else {
        finish({
          ok: false,
          detail: stderr.trim() || `auggie status exited with code ${code}`,
        });
      }
    });
  });
}

export function buildAuggieMcpSpec(): MCPServerSpec {
  return {
    name: AUGGIE_MCP_NAME,
    command: "auggie",
    args: ["mcp"],
  };
}

/**
 * Per PRD §2.5: drop oversized `codebase-retrieval` payloads and return a
 * model-readable hint instead. Other MCP tool calls pass through untouched.
 *
 * The byte-size check uses UTF-8 byte length, not character count, so a
 * payload of multi-byte characters is rejected at the same byte ceiling.
 */
export function makeOverflowMiddleware(maxBytes: number): ToolResultMiddleware {
  return (ctx, raw) => {
    if (ctx.serverName !== AUGGIE_MCP_NAME) return { block: false };
    if (ctx.toolName !== AUGGIE_TOOL_NAME) return { block: false };
    const byteLen = Buffer.byteLength(raw, "utf8");
    if (byteLen <= maxBytes) return { block: false };
    return {
      block: true,
      replacement:
        "Result too large. Please refine your codebase-retrieval query to be more specific.",
    };
  };
}
