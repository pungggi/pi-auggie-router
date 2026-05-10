import { spawn } from "node:child_process";
import type { MCPServerSpec, RouterSettings, ToolResultMiddleware } from "./types.js";

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
 * Per PRD §2.5: silent `auggie account status` pre-flight. Resolves with
 * `ok=false` if the binary is missing, exits non-zero, or hangs > 5s.
 */
/**
 * Patterns that may indicate secrets/tokens in stderr output.
 * Matches common API key formats, Bearer tokens, and long hex strings.
 */
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]\s*[:=]\s*\S+/g,
  /[Ss][Ee][Cc][Rr][Ee][Tt]\s*[:=]\s*\S+/g,
  /[Tt][Oo][Kk][Ee][Nn]\s*[:=]\s*\S+/g,
  /sk-[A-Za-z0-9\-._]{20,}/g,
  /[0-9a-f]{40,}/gi,
];

/**
 * Redact potential secrets from a string. Replaces matched regions
 * with `[REDACTED]`.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function appendCapped(
  current: string,
  chunk: Buffer | string,
  maxChars: number
): string {
  const next = current + chunk.toString();
  return next.length > maxChars ? next.slice(-maxChars) : next;
}

export function runAuggieStatus(
  settings?: Pick<RouterSettings, "auggieBinPath">,
  timeoutMs = 5_000
): Promise<PreflightResult> {
  const binPath = settings?.auggieBinPath ?? "auggie";
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (res: PreflightResult) => {
      if (resolved) return;
      resolved = true;
      resolve(res);
    };

    let child;
    try {
      child = spawn(binPath, ["account", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, detail: (err as Error).message });
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = appendCapped(stderr, d, 64 * 1024);
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
      finish({ ok: false, detail: "auggie account status timed out" });
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
          detail: stderr.trim() || `auggie account status exited with code ${code}`,
        });
      }
    });
  });
}

/**
 * Compose multiple ToolResultMiddleware functions into a single middleware.
 * The first middleware to return `{ block: true }` wins; remaining middleware
 * is not called. Middleware order is significant: earlier middleware has
 * higher priority.
 */
export function composeMiddleware(
  ...middlewares: ToolResultMiddleware[]
): ToolResultMiddleware {
  return (ctx, rawResult) => {
    for (const mw of middlewares) {
      const result = mw(ctx, rawResult);
      if (result.block) return result;
    }
    return { block: false };
  };
}

export function buildAuggieMcpSpec(
  settings: Pick<RouterSettings, "auggieBinPath">
): MCPServerSpec {
  return {
    name: AUGGIE_MCP_NAME,
    command: settings.auggieBinPath,
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
