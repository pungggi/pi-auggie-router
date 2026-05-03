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
