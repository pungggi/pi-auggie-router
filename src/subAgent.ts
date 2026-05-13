import { createHash } from "node:crypto";
import {
  AUGGIE_DIRECTIVE,
  buildAuggieMcpSpec,
  buildContextMemoryMcpSpec,
  composeMiddleware,
  makeOverflowMiddleware,
} from "./auggie.js";
import { ContextMemoryStore } from "./contextMemory.js";
import { type ExecutionTraceStore, makeTraceMiddleware } from "./executionTrace.js";
import type {
  ExecutionRoute,
  MCPServerSpec,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
  SubAgentResult,
  ToolResultMiddleware,
} from "./types.js";

export interface ExecutionInput {
  skill: ParsedSkill;
  brief: SkillBrief;
  /** Already mapped to the gateway-qualified ID. */
  resolvedModel: string;
  /**
   * Additional text appended to every sub-agent system prompt, after the
   * AUGGIE_DIRECTIVE. Use this to inject domain-specific rules (e.g. DDD
   * enforcement) into sub-agent context.
   *
   * Accepts a static string (evaluated once at mount time) or a callback
   * (evaluated lazily at each execution). Use the callback form when the
   * appendix depends on mutable state (e.g. active bounded context).
   */
  systemPromptAppendix?: string | (() => string);
  /**
   * Additional MCP servers to attach to the sub-agent alongside auggie.
   * These are appended after the auggie MCP server spec.
   */
  additionalMcpServers?: MCPServerSpec[];
  /**
   * Additional tool result middleware functions. These run after the
   * built-in overflow middleware, in the order given.
   */
  additionalToolMiddleware?: ToolResultMiddleware[];
  /**
   * Effective Auggie overflow ceiling for this run (Action 4). When omitted,
   * the static `settings.overflowCeilingBytes` is used. Sticky for the whole
   * sub-agent lifetime — do not mutate.
   */
  overflowCeilingBytes?: number;
  /**
   * Action 1 — pre-built context memory store. When provided, the overflow
   * middleware stashes oversized payloads into it and the caller owns
   * lifecycle (creation + dispose). When omitted, `executeSkill` creates and
   * disposes its own store iff `settings.contextMemory.enabled` is true.
   *
   * Sharing a store across executeSkill calls (e.g. parallel workers) lets
   * workers see each other's overflow handles, but it also extends the
   * data's lifetime — only do this for genuinely co-scoped runs.
   */
  contextMemory?: ContextMemoryStore;
  /**
   * Execution trace store for skill debugging and observability. When provided,
   * `executeSkill` composes `makeTraceMiddleware(store)` before the
   * overflow middleware so every tool call is recorded.
   * The caller owns lifecycle: create before execution, finalize + persist
   * after.
   */
  traceStore?: ExecutionTraceStore;
  /**
   * Execution route from the Judge, forwarded to the trace store metadata.
   * Optional — only used when `traceStore` is provided.
   */
  route?: ExecutionRoute;
}

/**
 * Construct the provider-facing system prompt for a sub-agent run.
 *
 * Cache-stability invariant: this function depends ONLY on the skill
 * instructions and the optional appendix. Dynamic per-run data (the brief,
 * execution route, selected model, user goal) must NOT enter the system
 * prompt — it goes into `userPrompt` instead. Keeping the prefix
 * byte-stable across invocations of the same skill maximizes provider
 * prompt-cache hit rate.
 */
export function buildSubAgentSystemPrompt(input: {
  skillInstructions: string;
  appendix?: string;
}): string {
  const parts: string[] = [input.skillInstructions, AUGGIE_DIRECTIVE];
  const appendix = input.appendix ?? "";
  if (appendix !== "") parts.push(appendix);
  return parts.join("\n\n");
}

function renderBrief(brief: SkillBrief): string {
  const parts: string[] = [];
  parts.push(`User Goal: ${brief.userGoal || "(unspecified)"}`);
  if (brief.constraints.length) {
    parts.push(`Constraints:\n- ${brief.constraints.join("\n- ")}`);
  }
  const MAX_KNOWN_CONTEXT_CHARS = 500;
  if (brief.knownContext.trim()) {
    const ctx = brief.knownContext.trim();
    parts.push(
      `Known Context:\n${
        ctx.length > MAX_KNOWN_CONTEXT_CHARS
          ? ctx.slice(0, MAX_KNOWN_CONTEXT_CHARS) + "\n[...truncated]"
          : ctx
      }`
    );
  }
  if (brief.userClarifications.length) {
    parts.push(
      `User Clarifications:\n- ${brief.userClarifications.join("\n- ")}`
    );
  }
  return parts.join("\n\n");
}

export async function executeSkill(
  host: PiHost,
  settings: RouterSettings,
  input: ExecutionInput
): Promise<SubAgentResult> {
  // Resolve the appendix: evaluate callbacks lazily so active-context
  // changes are picked up between skill executions.
  const rawAppendix = input.systemPromptAppendix;
  const appendix = typeof rawAppendix === "function" ? rawAppendix() : rawAppendix;

  const systemPrompt = buildSubAgentSystemPrompt({
    skillInstructions: input.skill.instructions,
    appendix,
  });

  if (settings.debugPromptPrefixHash) {
    const bytes = Buffer.byteLength(systemPrompt, "utf8");
    const sha256 = createHash("sha256").update(systemPrompt, "utf8").digest("hex");
    host.log?.(
      "debug",
      JSON.stringify({
        event: "auggie-router.prompt-prefix",
        skill: input.skill.name,
        sha256,
        bytes,
      })
    );
  }

  const overflowCeiling =
    typeof input.overflowCeilingBytes === "number" &&
    input.overflowCeilingBytes > 0
      ? input.overflowCeilingBytes
      : settings.overflowCeilingBytes;

  // Action 1 — when contextMemory is enabled and the caller did not pass an
  // existing store, create and own one for the lifetime of this run.
  // Use file-backed storage so the companion MCP server can serve read/list.
  let ownedStore: ContextMemoryStore | undefined;
  let store = input.contextMemory;
  if (!store && settings.contextMemory.enabled) {
    ownedStore = new ContextMemoryStore(settings.contextMemory, true);
    store = ownedStore;
  }

  // Trace middleware (non-blocking observer) — composed BEFORE overflow
  // middleware so it sees the raw payload before potential replacement.
  const traceMw = input.traceStore ? makeTraceMiddleware(input.traceStore) : null;

  const overflowMw = makeOverflowMiddleware(overflowCeiling, { store });
  const middleware = [
    traceMw,
    overflowMw,
    ...(input.additionalToolMiddleware ?? []),
  ].filter(<T>(x: T | null): x is T => x !== null);
  const composed = middleware.length === 1
    ? middleware[0]!
    : composeMiddleware(...middleware);

  // Build the MCP server list: auggie (always) + context-memory (when store
  // has file-backed storage) + any caller-provided servers.
  const contextMemoryMcp = store?.tempDir
    ? buildContextMemoryMcpSpec(store.tempDir)
    : undefined;
  const mcpServers: MCPServerSpec[] = [
    buildAuggieMcpSpec(settings),
    ...(contextMemoryMcp ? [contextMemoryMcp] : []),
    ...(input.additionalMcpServers ?? []),
  ];

  try {
    return await host.runSubAgent({
      model: input.resolvedModel,
      systemPrompt,
      userPrompt: renderBrief(input.brief),
      temperature: settings.subAgentTemperature,
      mcpServers,
      toolResultMiddleware: composed,
      totalTimeoutMs: settings.totalTimeoutMs,
      inactivityTimeoutMs: settings.inactivityTimeoutMs,
    });
  } finally {
    ownedStore?.dispose();
  }
}
