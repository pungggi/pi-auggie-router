/**
 * Action 6 — Parallel Independent Sub-Agents.
 *
 * Run an explicit list of `SubtaskBrief`s as concurrent worker sub-agents,
 * each with its own isolated prompt + MCP stack + overflow middleware. The
 * synthesizer is deterministic concatenation — no extra LLM call — so the
 * runner is testable without a real model.
 *
 * MVP scope (per docs/context-management-action-plans.md):
 *   - Disabled by default (`settings.parallelSubagents.enabled === false`).
 *   - Caller passes subtasks explicitly; the router does not decompose tasks.
 *   - Each worker runs `host.runSubAgent` directly with the skill's system
 *     prompt + AUGGIE_DIRECTIVE, plus the subtask brief in the user prompt.
 *   - Per-worker output cap; total timeout shared across the run.
 *   - Worker outputs are sanitized only by the per-worker char cap; the
 *     final-output sanitizer (Action 7) is the caller's responsibility.
 *   - Failures are captured per-worker; one failing worker does NOT cancel
 *     siblings (partial results allowed).
 */

import {
  AUGGIE_DIRECTIVE,
  buildAuggieMcpSpec,
  composeMiddleware,
  makeOverflowMiddleware,
} from "./auggie.js";
import { ContextMemoryStore } from "./contextMemory.js";
import { buildSubAgentSystemPrompt } from "./subAgent.js";
import type {
  MCPServerSpec,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SubAgentResult,
  SubtaskBrief,
  ToolResultMiddleware,
} from "./types.js";

export interface ParallelExecutionInput {
  skill: ParsedSkill;
  /** Already mapped to gateway-qualified ID (same contract as ExecutionInput). */
  resolvedModel: string;
  systemPromptAppendix?: string | (() => string);
  additionalMcpServers?: MCPServerSpec[];
  additionalToolMiddleware?: ToolResultMiddleware[];
  /** Effective Auggie overflow ceiling per worker; falls back to settings. */
  overflowCeilingBytes?: number;
  /** Subtasks to dispatch; one worker per entry. */
  subtasks: SubtaskBrief[];
  /**
   * Override for `settings.parallelSubagents.maxSubagents`. Bounded by the
   * settings cap so config can't be silently relaxed at runtime.
   */
  maxConcurrency?: number;
  /** Per-worker char cap override. Falls back to settings. 0 disables. */
  perWorkerOutputCharCap?: number;
}

export type WorkerStoppedReason =
  | SubAgentResult["stoppedReason"]
  | "cap"
  | "error";

export interface WorkerResult {
  id: string;
  goal: string;
  text: string;
  stoppedReason: WorkerStoppedReason;
  durationMs: number;
  /** Populated only when `stoppedReason === "error"`. */
  error?: string;
  /** True when the per-worker cap clipped output. */
  truncated: boolean;
}

export interface ParallelExecutionResult {
  workers: WorkerResult[];
  /** Deterministic synthesis: a markdown report combining each worker's text. */
  synthesizedText: string;
}

const TRUNCATION_MARKER = "\n\n[…worker output truncated]";

function renderSubtaskUserPrompt(brief: SubtaskBrief): string {
  const parts: string[] = [];
  parts.push(`Subtask ID: ${brief.id}`);
  parts.push(`Goal: ${brief.goal.trim() || "(unspecified)"}`);
  if (brief.scope?.trim()) parts.push(`Scope: ${brief.scope.trim()}`);
  if (brief.retrievalHints?.length) {
    parts.push(`Retrieval hints:\n- ${brief.retrievalHints.join("\n- ")}`);
  }
  if (brief.outputSchema?.trim()) {
    parts.push(`Output format: ${brief.outputSchema.trim()}`);
  }
  parts.push(
    "Stay strictly within scope. Use `codebase-retrieval` for any context. Return only your findings — no preamble."
  );
  return parts.join("\n\n");
}

function clipOutput(
  text: string,
  cap: number
): { text: string; truncated: boolean } {
  if (cap <= 0 || text.length <= cap) return { text, truncated: false };
  const sliceTo = Math.max(0, cap - TRUNCATION_MARKER.length);
  return { text: text.slice(0, sliceTo) + TRUNCATION_MARKER, truncated: true };
}

function synthesize(workers: WorkerResult[]): string {
  if (workers.length === 0) return "";
  const sections: string[] = ["## Parallel sub-agent synthesis\n"];
  for (const w of workers) {
    sections.push(`### ${w.id} — ${w.goal}`);
    if (w.stoppedReason === "error") {
      sections.push(`_Worker failed: ${w.error ?? "unknown error"}._`);
    } else {
      const reasonNote =
        w.stoppedReason === "completed"
          ? ""
          : `\n\n_Stopped reason: ${w.stoppedReason}._`;
      sections.push(w.text.trim() + reasonNote);
    }
    sections.push("");
  }
  return sections.join("\n").trimEnd() + "\n";
}

/**
 * Run an explicit list of subtask briefs as isolated worker sub-agents and
 * return a deterministic synthesis. Disabled by default — callers must
 * confirm `settings.parallelSubagents.enabled` themselves before invoking.
 */
export async function runParallelSubagents(
  host: PiHost,
  settings: RouterSettings,
  input: ParallelExecutionInput
): Promise<ParallelExecutionResult> {
  if (!settings.parallelSubagents.enabled) {
    throw new Error(
      "pi-auggie-router: parallelSubagents.enabled=false — refusing to run"
    );
  }
  const subtasks = input.subtasks ?? [];
  if (subtasks.length === 0) {
    return { workers: [], synthesizedText: "" };
  }
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (!s.id || typeof s.id !== "string") {
      throw new Error("pi-auggie-router: subtask.id must be a non-empty string");
    }
    if (ids.has(s.id)) {
      throw new Error(`pi-auggie-router: duplicate subtask.id "${s.id}"`);
    }
    ids.add(s.id);
  }

  const settingsMax = settings.parallelSubagents.maxSubagents;
  const requestedMax =
    typeof input.maxConcurrency === "number" && input.maxConcurrency > 0
      ? input.maxConcurrency
      : settingsMax;
  const concurrency = Math.max(
    1,
    Math.min(settingsMax, requestedMax, subtasks.length)
  );

  const overflowCeiling =
    typeof input.overflowCeilingBytes === "number" &&
    input.overflowCeilingBytes > 0
      ? input.overflowCeilingBytes
      : settings.overflowCeilingBytes;

  // Resolve appendix once — same convention as executeSkill.
  const rawAppendix = input.systemPromptAppendix;
  const appendix =
    typeof rawAppendix === "function" ? rawAppendix() : rawAppendix;

  const systemPrompt = buildSubAgentSystemPrompt({
    skillInstructions: input.skill.instructions,
    appendix,
  });

  const defaultCap =
    typeof input.perWorkerOutputCharCap === "number"
      ? input.perWorkerOutputCharCap
      : settings.parallelSubagents.perWorkerOutputCharCap;

  // Each worker gets its own context-memory store when the feature is on, so
  // overflow handles never leak across workers (each worker's investigation
  // is supposed to be independent — that's the whole point of the split).
  const runWorker = async (brief: SubtaskBrief): Promise<WorkerResult> => {
    const started = Date.now();
    const cap =
      typeof brief.maxOutputChars === "number" ? brief.maxOutputChars : defaultCap;

    const ownedStore = settings.contextMemory.enabled
      ? new ContextMemoryStore(settings.contextMemory)
      : undefined;

    const overflowMw = makeOverflowMiddleware(overflowCeiling, {
      store: ownedStore,
    });
    const middleware = input.additionalToolMiddleware?.length
      ? composeMiddleware(overflowMw, ...input.additionalToolMiddleware)
      : overflowMw;

    try {
      const sub = await host.runSubAgent({
        model: input.resolvedModel,
        systemPrompt,
        userPrompt: renderSubtaskUserPrompt(brief),
        temperature: settings.subAgentTemperature,
        mcpServers: [
          buildAuggieMcpSpec(settings),
          ...(input.additionalMcpServers ?? []),
        ],
        toolResultMiddleware: middleware,
        totalTimeoutMs: settings.totalTimeoutMs,
        inactivityTimeoutMs: settings.inactivityTimeoutMs,
      });
      const clipped = clipOutput(sub.finalText, cap);
      const stopped: WorkerStoppedReason = clipped.truncated
        ? "cap"
        : sub.stoppedReason;
      return {
        id: brief.id,
        goal: brief.goal,
        text: clipped.text,
        stoppedReason: stopped,
        durationMs: Date.now() - started,
        truncated: clipped.truncated,
      };
    } catch (err) {
      return {
        id: brief.id,
        goal: brief.goal,
        text: "",
        stoppedReason: "error",
        durationMs: Date.now() - started,
        error: (err as Error).message,
        truncated: false,
      };
    } finally {
      ownedStore?.dispose();
    }
  };

  // Bounded-concurrency runner. Maintains input order in `workers`.
  const workers: WorkerResult[] = new Array(subtasks.length);
  let cursor = 0;
  const launch = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= subtasks.length) return;
      workers[idx] = await runWorker(subtasks[idx]!);
    }
  };
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) lanes.push(launch());
  await Promise.all(lanes);

  return { workers, synthesizedText: synthesize(workers) };
}
