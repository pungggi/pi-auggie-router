/**
 * Public type contracts for pi-auggie-router.
 *
 * The router is host-agnostic: any Pi-compatible host that satisfies
 * `PiHost` can mount this plugin via `createRouter(host)`.
 */

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface LLMCallOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  responseFormat?: "text" | "json";
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
}

export interface MCPServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SubAgentRunOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  mcpServers: MCPServerSpec[];
  toolResultMiddleware?: ToolResultMiddleware;
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
  signal?: AbortSignal;
}

export interface ToolCallContext {
  serverName: string;
  toolName: string;
  args: unknown;
}

/**
 * Allows the host to filter / rewrite tool results before they reach the
 * sub-agent loop. Returning `{ block: true, replacement: string }` aborts the
 * tool invocation and feeds `replacement` back to the model instead.
 */
export type ToolResultMiddleware = (
  ctx: ToolCallContext,
  rawResult: string
) => { block: false } | { block: true; replacement: string };

export interface SubAgentResult {
  finalText: string;
  stoppedReason: "completed" | "timeout" | "inactivity" | "aborted";
}

export interface UIInputInterceptor {
  (message: string): { cancel: boolean };
}

/**
 * The minimal surface area pi-auggie-router needs from the Pi host.
 * Hosts inject this via `createRouter(host)`.
 */
export interface PiHost {
  /** Append a system-level message to the visible main thread. */
  postSystemMessage: (text: string) => void;
  /** Append a normal assistant-style message to the main thread. */
  postAssistantMessage: (text: string) => void;
  /** Lock or unlock the user's main editor input. */
  setInputLocked: (locked: boolean, reason?: string) => void;
  /** Read the most recent N chat messages from the main thread. */
  getRecentMessages: (count: number) => ChatMessage[];
  /** Cheap routing-class LLM call (used by Actor & Judge). */
  callLLM: (opts: LLMCallOptions) => Promise<LLMResponse>;
  /** Run an isolated Pi sub-agent with MCP servers attached. */
  runSubAgent: (opts: SubAgentRunOptions) => Promise<SubAgentResult>;
  /** Register a `before-message` hook. Return `{cancel:true}` to swallow. */
  onBeforeMessage: (cb: (msg: string) => { cancel: boolean }) => () => void;
  /** Register an input hook scoped to the `/skill:` regex prefix. */
  onUserInput: (cb: (raw: string) => { cancel: boolean } | void) => () => void;
  /** Resolve a path inside the active workspace (for `.pi/` lookups). */
  resolveWorkspacePath: (relative: string) => string;
  /** Resolve a path inside the user's home dir (`~/.pi/...`). */
  resolveHomePath: (relative: string) => string;
  /** Optional logger; falls back to no-op. */
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
}

/**
 * Action 1 — Overflow Context Memory.
 *
 * Execution-scoped store for oversized Auggie payloads. When enabled, the
 * overflow middleware persists the blocked payload and returns a compact
 * handle (`overflow_<n>`) plus a head/tail preview instead of dropping the
 * data entirely. The store is created before `runSubAgent` and disposed when
 * the sub-agent resolves or rejects — there is no cross-run state.
 */
export interface ContextMemorySettings {
  enabled: boolean;
  /** Hard cap on entries per skill execution. */
  maxEntries: number;
  /** Hard cap on total stored bytes per skill execution. */
  maxBytesPerRun: number;
  /** Head-window chars used in the preview returned to the model. */
  previewHeadChars: number;
  /** Tail-window chars used in the preview returned to the model. */
  previewTailChars: number;
}

/**
 * Action 6 — Parallel Independent Sub-Agents.
 *
 * Disabled by default. When opted in, callers may pass a `subtasks` array to
 * `runParallelSubagents(...)` to split a heavy investigation into independent
 * isolated worker sub-agents. Each worker has its own context window, MCP
 * stack, and overflow ceiling. Outputs are capped and combined via the
 * deterministic synthesizer (no extra LLM call).
 */
export interface ParallelSubagentsSettings {
  enabled: boolean;
  /** Hard cap on concurrently-running worker sub-agents. */
  maxSubagents: number;
  /** Per-worker char cap on returned text. 0 disables the cap. */
  perWorkerOutputCharCap: number;
}

/**
 * One independent unit of work for the parallel sub-agent runner. Subtasks
 * are passed in by the caller; the router does NOT decompose tasks itself in
 * the MVP — explicit input only.
 */
export interface SubtaskBrief {
  /** Stable ID for logs / synthesis ordering. Unique per parallel run. */
  id: string;
  /** What this worker should accomplish. Required. */
  goal: string;
  /** Optional scope boundary the worker should respect. */
  scope?: string;
  /** Optional retrieval hints — keywords, paths, package names, etc. */
  retrievalHints?: string[];
  /** Optional output-format expectation surfaced to the worker. */
  outputSchema?: string;
  /** Optional per-worker char cap; falls back to settings cap when omitted. */
  maxOutputChars?: number;
}

export interface OutputSanitizerSettings {
  enabled: boolean;
  /** Hard cap on final answer characters. 0 disables the cap. */
  finalOutputMaxChars: number;
  /** Strip clearly-marked tool traces / MCP envelopes. */
  stripToolTraces: boolean;
}

/**
 * Action 4 — Context Budget by Execution Tier.
 *
 * When enabled, the sub-agent overflow ceiling is derived from the effective
 * route tier instead of the static top-level `overflowCeilingBytes`. The
 * Actor/Judge history budget is NOT tier-driven (history must be assembled
 * before the route is known); that is an explicit future extension.
 */
export interface ContextBudgetSettings {
  enabled: boolean;
  /** Per-tier sub-agent overflow ceiling, bytes. Missing tier → top-level fallback. */
  overflowCeilingBytes: Partial<Record<ExecutionRoutingTier, number>>;
}

export type HistoryStrategy = "recent" | "headTail";
export type HistoryMiddleMode = "marker" | "omit";

/**
 * Action 3 — Head/Tail Chat History Assembly.
 *
 * Controls how the Actor/Judge loop selects messages from the host-provided
 * window. `recent` preserves legacy behaviour (pass through unchanged). The
 * `headTail` strategy keeps the earliest task-setting messages plus the
 * latest, with the middle omitted or replaced by an explicit marker.
 */
export interface HistoryAssemblySettings {
  strategy: HistoryStrategy;
  /** Number of leading messages preserved (only used with `headTail`). */
  headMessages: number;
  /** Number of trailing messages preserved (only used with `headTail`). */
  tailMessages: number;
  /** What to do with the dropped middle: insert a marker, or silently omit. */
  middleMode: HistoryMiddleMode;
  /** Per-message char cap before injection into Actor/Judge prompts. 0 disables. */
  maxCharsPerMessage: number;
  /** Total char cap across the assembled history. 0 disables. */
  maxTotalChars: number;
}

export interface RouterSettings {
  /** LLM gateway prefix; e.g. `openrouter`. */
  defaultProvider: string;
  /** Override for the routing engine (Actor + Judge). */
  routingModel: string;
  /** History window for Actor brief assembly. */
  historyWindow: number;
  /** Max iterations of the 2-pass loop. */
  maxJudgeIterations: number;
  /** Per-call timeout for Actor / Judge routing-LLM calls, ms. */
  routingTimeoutMs: number;
  /** Maximum time to wait for the user's Q&A clarification reply, ms. */
  qaTimeoutMs: number;
  /** Total sub-agent execution cap, ms. */
  totalTimeoutMs: number;
  /** MCP/tool inactivity cap, ms. */
  inactivityTimeoutMs: number;
  /** Sub-agent temperature. */
  subAgentTemperature: number;
  /** Single-payload Auggie ceiling, bytes. */
  overflowCeilingBytes: number;
  /**
   * Absolute or relative path to the `auggie` binary.
   * Defaults to `"auggie"` (relies on $PATH resolution).
   * Setting this explicitly avoids PATH-based attacks in shared environments.
   */
  auggieBinPath: string;
  /**
   * Allowed model provider prefixes for SKILL frontmatter `model:` values.
   * If set, fully-qualified models not matching a prefix in this list are
   * rejected at mapping time. Empty array = allow all (legacy behaviour).
   */
  allowedProviderPrefixes: string[];
  /** Adaptive execution-model routing config. Disabled by default. */
  executionRouting: ExecutionRoutingSettings;
  /**
   * Emit a debug-level log entry containing only a SHA-256 hash and byte
   * size of the sub-agent system prompt prefix. Used to detect cache-busting
   * regressions. Never logs prompt text. Defaults to `false`.
   */
  debugPromptPrefixHash: boolean;
  /** Final-output sanitization config. */
  outputSanitizer: OutputSanitizerSettings;
  /** Action 4 — tier-driven sub-agent context budgets. Disabled by default. */
  contextBudgets: ContextBudgetSettings;
  /** Action 3 — chat-history assembly strategy. Defaults to legacy `recent`. */
  historyAssembly: HistoryAssemblySettings;
  /** Action 1 — execution-scoped overflow memory. Disabled by default. */
  contextMemory: ContextMemorySettings;
  /** Action 6 — parallel independent sub-agents. Disabled by default. */
  parallelSubagents: ParallelSubagentsSettings;
}

export type ExecutionRoutingPreference =
  | "preferCheap"
  | "balanced"
  | "preferBest";

export type ExecutionRoutingTier = "cheap" | "balanced" | "frontier";

export type SkillModelPolicy = "pin" | "ignore";

export interface ExecutionRoutingSettings {
  enabled: boolean;
  preference: ExecutionRoutingPreference;
  surfaceDecision: boolean;
  skillModelPolicy: SkillModelPolicy;
  models: Partial<Record<ExecutionRoutingTier, string>>;
}

export interface ExecutionRoute {
  tier: ExecutionRoutingTier;
  complexity: "low" | "medium" | "high";
  risk:
    | "read_only"
    | "small_edit"
    | "multi_file_edit"
    | "architecture_change"
    | "unknown";
  /** 0..1 */
  confidence: number;
  reason: string;
}

export interface ParsedSkill {
  name: string;
  filePath: string;
  /** Raw YAML frontmatter `model:` value, if present. */
  rawModel: string | undefined;
  /** Markdown body after frontmatter. */
  instructions: string;
}

export interface SkillBrief {
  userGoal: string;
  constraints: string[];
  /** Free-form context the Actor pulled from chat history. */
  knownContext: string;
  /** Filled in after Q&A fallback, if any. */
  userClarifications: string[];
}

export interface JudgeRubric {
  hasUserGoal: boolean;
  hasRequiredInputs: boolean;
  hasScopeBoundary: boolean;
  isUnambiguous: boolean;
  /** When any boolean is false, the question to surface to the user. */
  missingRequirementQuestion?: string;
}
