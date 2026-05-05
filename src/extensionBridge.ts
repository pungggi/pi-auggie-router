/**
 * Extension bridge: adapts Pi's ExtensionAPI to the PiHost interface.
 *
 * This allows the auggie router to be mounted from within a Pi extension
 * without requiring direct access to Pi's internal host APIs.
 *
 * Some PiHost methods have degraded behavior when accessed through the bridge:
 * - `getRecentMessages()` returns `[]` (no chat history available from extensions)
 * - `onUserInput()` / `onBeforeMessage()` are limited (extensions use registerCommand instead)
 * - `callLLM()` and `runSubAgent()` use child processes
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type {
  ChatMessage,
  LLMCallOptions,
  LLMResponse,
  PiHost,
  SubAgentResult,
  SubAgentRunOptions,
} from "./types.js";

export interface BridgeOptions {
  /** Called once to log degraded capabilities. Defaults to stderr. */
  log?: (level: string, msg: string) => void;
}

function writeTempFile(prefix: string, content: string): string {
  const tmpDir = join(tmpdir(), `pi-bridge-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const filePath = join(tmpDir, `${prefix}.md`);
  writeFileSync(filePath, content, { encoding: "utf8" });
  return filePath;
}

function cleanupTemp(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* ignore */ }
  try { rmSync(dirname(filePath), { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Spawn a short-lived `pi` child process for an LLM call.
 * Uses `--mode json` for structured output and `--no-session` for isolation.
 */
async function callLLmViaChildProcess(opts: LLMCallOptions): Promise<LLMResponse> {
  const args = [
    "--mode", "json",
    "--model", opts.model,
    "-p",
    "--no-session",
  ];

  // Build the prompt from messages
  const lastUserMsg = [...opts.messages].reverse().find(m => m.role === "user");
  const promptText = lastUserMsg?.content ?? "";

  // If there are system messages, write them to a temp file
  const systemParts = opts.messages.filter(m => m.role === "system").map(m => m.content);
  let systemFile: string | undefined;
  if (systemParts.length > 0) {
    systemFile = writeTempFile("llm-system", systemParts.join("\n\n"));
    args.push("--append-system-prompt", systemFile);
  }

  if (opts.temperature !== undefined) {
    args.push("--temperature", String(opts.temperature));
  }

  const prompt = promptText ?? "";
  return new Promise<LLMResponse>((resolve, reject) => {
    const child = spawn("pi", [...args, prompt!], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (systemFile) cleanupTemp(systemFile);
      reject(new Error("callLLM timed out after 60s"));
    }, 60_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (systemFile) cleanupTemp(systemFile);
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (systemFile) cleanupTemp(systemFile);
      if (code !== 0) {
        reject(new Error(`callLLM child exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        // Parse JSON response from pi --mode json
        const lines = stdout.trim().split("\n");
        const lastLine = lines[lines.length - 1] ?? "";
        const parsed = JSON.parse(lastLine);
        resolve({ text: parsed.content ?? parsed.text ?? stdout });
      } catch {
        // Fallback: return raw stdout
        resolve({ text: stdout.trim() });
      }
    });
  });
}

/**
 * Spawn a pi child process to run a sub-agent.
 * Writes system prompt to a temp file and passes MCP server config.
 */
async function runSubAgentViaChildProcess(opts: SubAgentRunOptions): Promise<SubAgentResult> {
  const args = [
    "--mode", "json",
    "--model", opts.model,
    "-p",
    "--no-session",
  ];

  // Write system prompt to temp file
  const systemFile = writeTempFile("subagent-system", opts.systemPrompt);
  args.push("--append-system-prompt", systemFile);

  if (opts.temperature !== undefined) {
    args.push("--temperature", String(opts.temperature));
  }

  // Write MCP server config to temp file if provided
  let mcpConfigFile: string | undefined = undefined;
  if (opts.mcpServers?.length) {
    const mcpConfig: Record<string, unknown> = {};
    for (const server of opts.mcpServers) {
      mcpConfig[server.name] = {
        command: server.command,
        args: server.args,
        env: server.env,
      };
    }
    mcpConfigFile = writeTempFile("mcp-config", JSON.stringify({ mcpServers: mcpConfig }));
    args.push("--mcp-config", mcpConfigFile);
  }

  return new Promise<SubAgentResult>((resolve, reject) => {
    const child = spawn("pi", [...args, opts.userPrompt ?? ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timeout = opts.totalTimeoutMs || 300_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanupFiles();
      reject(new Error(`Sub-agent timed out after ${timeout}ms`));
    }, timeout);

    function cleanupFiles() {
      cleanupTemp(systemFile);
      if (mcpConfigFile) cleanupTemp(mcpConfigFile);
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      cleanupFiles();
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      cleanupFiles();
      if (code !== 0) {
        reject(new Error(`Sub-agent exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const lines = stdout.trim().split("\n");
        const lastLine = lines[lines.length - 1] ?? "";
        const parsed = JSON.parse(lastLine);
        resolve({
          finalText: parsed.content ?? parsed.text ?? stdout.trim(),
          stoppedReason: parsed.stoppedReason ?? "completed",
        });
      } catch {
        resolve({
          finalText: stdout.trim(),
          stoppedReason: "completed",
        });
      }
    });
  });
}

/**
 * Create a PiHost adapter that bridges to Pi's ExtensionAPI.
 *
 * The bridge degrades gracefully where ExtensionAPI lacks direct equivalents:
 * - `getRecentMessages()` returns `[]` (no chat history in extensions)
 * - `onUserInput()` / `onBeforeMessage()` are no-ops with a warning
 * - `callLLM()` and `runSubAgent()` spawn child `pi` processes
 *
 * @param pi - The ExtensionAPI instance provided by Pi to extensions
 * @param opts - Optional configuration for logging and capability hints
 */
export function createExtensionBridge(
  pi: any,
  opts: BridgeOptions = {}
): PiHost {
  const log = opts.log ?? ((level: string, msg: string) => {
    process.stderr.write(`[pi-auggie-router/bridge] [${level}] ${msg}\n`);
  });

  // Capability detection
  const hasSendMessage = typeof pi.sendMessage === "function";
  const hasSetInputLocked = typeof pi.setInputLocked === "function";

  if (!hasSendMessage) {
    log("warn", "ExtensionAPI.sendMessage() not found — postSystemMessage/postAssistantMessage will log to stderr only.");
  }
  if (!hasSetInputLocked) {
    log("warn", "ExtensionAPI.setInputLocked() not found — falling back to sendMessage or stderr for input locking.");
  }

  let warnedHistory = false;

  return {
    postSystemMessage(text: string) {
      if (hasSendMessage) {
        pi.sendMessage({
          role: "system",
          content: [{ type: "text", text }],
        });
      } else {
        log("info", `[System]: ${text}`);
      }
    },

    postAssistantMessage(text: string) {
      if (hasSendMessage) {
        pi.sendMessage({
          role: "assistant",
          content: [{ type: "text", text }],
        });
      } else {
        log("info", `[Assistant]: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
      }
    },

    setInputLocked(locked: boolean, reason?: string) {
      if (hasSetInputLocked) {
        pi.setInputLocked(locked, reason);
      } else if (hasSendMessage) {
        pi.sendMessage({
          role: "system",
          content: [{ type: "text", text: locked ? "🔒 Input locked" : "🔓 Input unlocked" }],
        });
      } else {
        log("debug", `Input ${locked ? "locked" : "unlocked"}${reason ? ` (${reason})` : ""}`);
      }
    },

    getRecentMessages(_count: number): ChatMessage[] {
      if (!warnedHistory) {
        log("info", "pi-auggie-router mounted via extension bridge — chat history unavailable for Actor/Judge.");
        warnedHistory = true;
      }
      return [];
    },

    async callLLM(llmOpts: LLMCallOptions): Promise<LLMResponse> {
      return callLLmViaChildProcess(llmOpts);
    },

    async runSubAgent(subOpts: SubAgentRunOptions): Promise<SubAgentResult> {
      return runSubAgentViaChildProcess(subOpts);
    },

    onUserInput(_cb) {
      log("warn", "onUserInput has limited support via extension bridge. /skill: interception may require pi.registerCommand fallback.");
      return () => {};
    },

    onBeforeMessage(_cb) {
      log("warn", "onBeforeMessage is not supported via extension bridge. Q&A fallback will not work.");
      return () => {};
    },

    resolveWorkspacePath(relative: string): string {
      return join(process.cwd(), relative);
    },

    resolveHomePath(relative: string): string {
      return join(homedir(), relative);
    },

    log(level, msg) {
      log(level, msg);
    },
  };
}
