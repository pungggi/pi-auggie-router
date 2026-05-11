/**
 * Execution Trace Store — persists the full sub-agent transcript
 * (tool calls, results, final output) keyed by skill name.
 *
 * Design rationale (from "Rethinking Agents — Harness Is All You Need"):
 *   The Tsinghua + DSPy research showed that raw execution traces are
 *   irreplaceable for harness self-improvement. When they replaced traces
 *   with summaries, accuracy dropped from 50% to 34%. This store captures
 *   the raw signal so future harness-evolution passes can read it.
 *
 * Lifetime:
 *   - Created before each `runSubAgent` call.
 *   - The overflow middleware and any additional middleware write entries.
 *   - After `runSubAgent` resolves, the caller calls `finalize(finalText, stoppedReason)`
 *     then persists via `persist(directory)`.
 *   - `dispose()` does NOT delete persisted files (unlike ContextMemoryStore).
 *
 * Storage format:
 *   Each trace is a JSON file at `<dir>/<skillName>_<timestamp>.json`:
 *   {
 *     "skillName": string,
 *     "timestamp": number,
 *     "model": string,
 *     "brief": { userGoal, constraints, knownContext, userClarifications },
 *     "route": { tier, complexity, risk, confidence, reason },
 *     "toolCalls": [
 *       { "index": number, "serverName": string, "toolName": string,
 *         "args": unknown, "resultPreview": string, "blocked": boolean,
 *         "timestamp": number }
 *     ],
 *     "finalText": string,
 *     "stoppedReason": string
 *   }
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRoute, SkillBrief } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallEntry {
  /** 0-based index within the execution. */
  index: number;
  serverName: string;
  toolName: string;
  args: unknown;
  /** First N characters of the raw result (capped to prevent unbounded growth). */
  resultPreview: string;
  /** Whether the middleware blocked this result. */
  blocked: boolean;
  timestamp: number;
}

export interface ExecutionTrace {
  skillName: string;
  timestamp: number;
  model: string;
  brief: SkillBrief;
  route: ExecutionRoute;
  toolCalls: ToolCallEntry[];
  finalText: string;
  stoppedReason: string;
}

export interface ExecutionTraceStoreSettings {
  enabled: boolean;
  /**
   * Maximum characters kept from each tool result for the preview.
   * The full payload is NOT stored (could be megabytes of codebase content).
   * Default: 2000.
   */
  maxResultPreviewChars: number;
  /**
   * Directory where trace JSON files are written by `persist()`.
   * Defaults to `.pi/traces/` in the workspace.
   */
  traceDirectory: string;
}

export const DEFAULT_EXECUTION_TRACE: ExecutionTraceStoreSettings = {
  enabled: true,
  maxResultPreviewChars: 2_000,
  traceDirectory: ".pi/traces",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ExecutionTraceStore {
  private toolCalls: ToolCallEntry[] = [];
  private callIndex = 0;
  private disposed = false;
  private _finalized = false;

  constructor(
    private readonly settings: ExecutionTraceStoreSettings,
    /** Skill metadata populated by the caller before finalize(). */
    public readonly meta: {
      skillName: string;
      model: string;
      brief: SkillBrief;
      route: ExecutionRoute;
    }
  ) {}

  /**
   * Record a tool call result. Called by the trace-capturing middleware.
   * Returns `true` if the entry was recorded, `false` if the store is
   * disabled or disposed.
   */
  record(
    ctx: { serverName: string; toolName: string; args: unknown },
    rawResult: string,
    blocked: boolean
  ): boolean {
    if (this.disposed || !this.settings.enabled) return false;

    const maxChars = this.settings.maxResultPreviewChars;
    const resultPreview =
      rawResult.length <= maxChars
        ? rawResult
        : rawResult.slice(0, maxChars) + `\n[...truncated, ${rawResult.length} total chars]`;

    this.toolCalls.push({
      index: this.callIndex++,
      serverName: ctx.serverName,
      toolName: ctx.toolName,
      args: ctx.args,
      resultPreview,
      blocked,
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * Finalize the trace with the sub-agent's terminal output.
   * Can only be called once.
   */
  finalize(finalText: string, stoppedReason: string): ExecutionTrace {
    if (this._finalized) {
      throw new Error("ExecutionTraceStore already finalized");
    }
    this._finalized = true;
    return {
      skillName: this.meta.skillName,
      timestamp: Date.now(),
      model: this.meta.model,
      brief: this.meta.brief,
      route: this.meta.route,
      toolCalls: [...this.toolCalls],
      finalText,
      stoppedReason,
    };
  }

  /**
   * Persist the trace to disk. Call after `finalize()`.
   * Creates the directory if it doesn't exist.
   * Returns the path of the written file.
   */
  persist(trace: ExecutionTrace, workspacePath: string): string {
    const dir = join(workspacePath, this.settings.traceDirectory);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filename = `${trace.skillName}_${trace.timestamp}.json`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, JSON.stringify(trace, null, 2), "utf8");
    return filepath;
  }

  /**
   * Load all persisted traces for a given skill name, sorted by timestamp
   * (newest first). Useful for feeding raw traces into the Actor/Judge loop
   * for harness self-evolution.
   */
  static loadTraces(
    traceDirectory: string,
    skillName: string
  ): ExecutionTrace[] {
    if (!existsSync(traceDirectory)) return [];
    const files = readdirSync(traceDirectory)
      .filter((f) => f.startsWith(`${skillName}_`) && f.endsWith(".json"))
      .sort()
      .reverse(); // newest first

    const traces: ExecutionTrace[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(traceDirectory, f), "utf8");
        traces.push(JSON.parse(raw) as ExecutionTrace);
      } catch {
        // Skip corrupted files silently.
      }
    }
    return traces;
  }

  get finalized(): boolean {
    return this._finalized;
  }

  get toolCallCount(): number {
    return this.toolCalls.length;
  }

  /** Mark as disposed. Does NOT delete persisted files. */
  dispose(): void {
    this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// Trace-capturing middleware
// ---------------------------------------------------------------------------

/**
 * Create a ToolResultMiddleware that records every tool call into the
 * ExecutionTraceStore. This middleware NEVER blocks — it only observes.
 * It should be composed *before* the overflow middleware so it sees the
 * raw payload before it might be replaced.
 */
export function makeTraceMiddleware(
  store: ExecutionTraceStore
): import("./types.js").ToolResultMiddleware {
  return (ctx, rawResult) => {
    // We cannot know at recording time whether a *later* middleware will
    // block this result. We record the pre-block state here and rely on a
    // second pass if blocking detection is needed. For MVP, recording all
    // calls (blocked or not) gives us the raw signal the research demands.
    store.record(ctx, rawResult, false);
    return { block: false };
  };
}
