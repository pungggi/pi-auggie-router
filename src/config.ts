import { readFileSync, existsSync } from "node:fs";
import type {
  ContextBudgetSettings,
  ContextMemorySettings,
  ExecutionRoutingPreference,
  ExecutionRoutingSettings,
  ExecutionRoutingTier,
  ExecutionTraceSettings,
  HistoryAssemblySettings,
  HistoryMiddleMode,
  HistoryStrategy,
  OutputSanitizerSettings,
  ParallelSubagentsSettings,
  PiHost,
  RouterSettings,
  SkillModelPolicy,
} from "./types.js";

export const DEFAULT_OUTPUT_SANITIZER: OutputSanitizerSettings = {
  enabled: true,
  finalOutputMaxChars: 120_000,
  stripToolTraces: true,
};

export const DEFAULT_CONTEXT_BUDGETS: ContextBudgetSettings = {
  enabled: false,
  overflowCeilingBytes: {
    cheap: 15_000,
    balanced: 25_000,
    frontier: 50_000,
  },
};

export const DEFAULT_CONTEXT_MEMORY: ContextMemorySettings = {
  enabled: false,
  maxEntries: 8,
  maxBytesPerRun: 1_000_000,
  previewHeadChars: 4_000,
  previewTailChars: 4_000,
};

export const DEFAULT_EXECUTION_TRACE: ExecutionTraceSettings = {
  enabled: true,
  maxResultPreviewChars: 2_000,
  traceDirectory: ".pi/traces",
};

export const DEFAULT_PARALLEL_SUBAGENTS: ParallelSubagentsSettings = {
  enabled: false,
  maxSubagents: 3,
  perWorkerOutputCharCap: 8_000,
};

export const DEFAULT_HISTORY_ASSEMBLY: HistoryAssemblySettings = {
  strategy: "recent",
  headMessages: 2,
  tailMessages: 12,
  middleMode: "marker",
  maxCharsPerMessage: 10_000,
  maxTotalChars: 60_000,
};

export const DEFAULT_EXECUTION_ROUTING: ExecutionRoutingSettings = {
  enabled: false,
  preference: "balanced",
  surfaceDecision: false,
  skillModelPolicy: "pin",
  models: {
    cheap: "anthropic/claude-3-5-haiku",
    balanced: "anthropic/claude-3-5-sonnet",
    frontier: "anthropic/claude-3-7-sonnet",
  },
};

export const DEFAULT_SETTINGS: RouterSettings = {
  defaultProvider: "openrouter",
  routingModel: "anthropic/claude-3-5-haiku",
  historyWindow: 20,
  maxJudgeIterations: 2,
  routingTimeoutMs: 60_000,
  qaTimeoutMs: 300_000,
  totalTimeoutMs: 300_000,
  inactivityTimeoutMs: 60_000,
  subAgentTemperature: 0.0,
  overflowCeilingBytes: 25_000,
  auggieBinPath: "auggie",
  allowedProviderPrefixes: [],
  executionRouting: DEFAULT_EXECUTION_ROUTING,
  debugPromptPrefixHash: false,
  outputSanitizer: DEFAULT_OUTPUT_SANITIZER,
  contextBudgets: DEFAULT_CONTEXT_BUDGETS,
  historyAssembly: DEFAULT_HISTORY_ASSEMBLY,
  contextMemory: DEFAULT_CONTEXT_MEMORY,
  parallelSubagents: DEFAULT_PARALLEL_SUBAGENTS,
  executionTrace: DEFAULT_EXECUTION_TRACE,
};

function cloneExecutionRouting(
  settings: ExecutionRoutingSettings = DEFAULT_EXECUTION_ROUTING
): ExecutionRoutingSettings {
  return {
    ...settings,
    models: { ...settings.models },
  };
}

function cloneOutputSanitizer(
  s: OutputSanitizerSettings = DEFAULT_OUTPUT_SANITIZER
): OutputSanitizerSettings {
  return { ...s };
}

function cloneContextBudgets(
  s: ContextBudgetSettings = DEFAULT_CONTEXT_BUDGETS
): ContextBudgetSettings {
  return {
    ...s,
    overflowCeilingBytes: { ...s.overflowCeilingBytes },
  };
}

function cloneHistoryAssembly(
  s: HistoryAssemblySettings = DEFAULT_HISTORY_ASSEMBLY
): HistoryAssemblySettings {
  return { ...s };
}

function cloneContextMemory(
  s: ContextMemorySettings = DEFAULT_CONTEXT_MEMORY
): ContextMemorySettings {
  return { ...s };
}

function cloneParallelSubagents(
  s: ParallelSubagentsSettings = DEFAULT_PARALLEL_SUBAGENTS
): ParallelSubagentsSettings {
  return { ...s };
}

function cloneExecutionTrace(
  s: ExecutionTraceSettings = DEFAULT_EXECUTION_TRACE
): ExecutionTraceSettings {
  return { ...s };
}

function cloneDefaultSettings(): RouterSettings {
  return {
    ...DEFAULT_SETTINGS,
    allowedProviderPrefixes: [...DEFAULT_SETTINGS.allowedProviderPrefixes],
    executionRouting: cloneExecutionRouting(),
    outputSanitizer: cloneOutputSanitizer(),
    contextBudgets: cloneContextBudgets(),
    historyAssembly: cloneHistoryAssembly(),
    contextMemory: cloneContextMemory(),
    parallelSubagents: cloneParallelSubagents(),
    executionTrace: cloneExecutionTrace(),
  };
}

function mergeSettings(validated: Partial<RouterSettings>): RouterSettings {
  const base = cloneDefaultSettings();
  return {
    ...base,
    ...validated,
    allowedProviderPrefixes: validated.allowedProviderPrefixes
      ? [...validated.allowedProviderPrefixes]
      : base.allowedProviderPrefixes,
    executionRouting: validated.executionRouting
      ? cloneExecutionRouting(validated.executionRouting)
      : base.executionRouting,
    outputSanitizer: validated.outputSanitizer
      ? cloneOutputSanitizer(validated.outputSanitizer)
      : base.outputSanitizer,
    contextBudgets: validated.contextBudgets
      ? cloneContextBudgets(validated.contextBudgets)
      : base.contextBudgets,
    historyAssembly: validated.historyAssembly
      ? cloneHistoryAssembly(validated.historyAssembly)
      : base.historyAssembly,
    contextMemory: validated.contextMemory
      ? cloneContextMemory(validated.contextMemory)
      : base.contextMemory,
    parallelSubagents: validated.parallelSubagents
      ? cloneParallelSubagents(validated.parallelSubagents)
      : base.parallelSubagents,
    executionTrace: validated.executionTrace
      ? cloneExecutionTrace(validated.executionTrace)
      : base.executionTrace,
  };
}

const PREFERENCE_VALUES: ReadonlySet<ExecutionRoutingPreference> = new Set([
  "preferCheap",
  "balanced",
  "preferBest",
]);

const POLICY_VALUES: ReadonlySet<SkillModelPolicy> = new Set([
  "pin",
  "ignore",
]);

const TIER_VALUES: ReadonlySet<ExecutionRoutingTier> = new Set([
  "cheap",
  "balanced",
  "frontier",
]);

const HISTORY_STRATEGY_VALUES: ReadonlySet<HistoryStrategy> = new Set([
  "recent",
  "headTail",
]);

const HISTORY_MIDDLE_MODE_VALUES: ReadonlySet<HistoryMiddleMode> = new Set([
  "marker",
  "omit",
]);

interface PiSettingsFile {
  auggieRouter?: Partial<RouterSettings>;
}

// ---------------------------------------------------------------------------
// SEC-01: Validation helpers
// ---------------------------------------------------------------------------

function assertString(val: unknown, key: string): string {
  if (typeof val !== "string") {
    throw new Error(`auggieRouter.${key}: expected string, got ${typeof val}`);
  }
  return val;
}

function assertNumber(val: unknown, key: string): number {
  if (typeof val !== "number") {
    throw new Error(`auggieRouter.${key}: expected number, got ${typeof val}`);
  }
  return val;
}

function assertInt(val: unknown, key: string, min: number, max: number): number {
  const n = assertNumber(val, key);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(
      `auggieRouter.${key}: must be a finite integer between ${min} and ${max}, got ${n}`
    );
  }
  return n;
}

function assertNonEmptyString(val: unknown, key: string): string {
  const s = assertString(val, key);
  if (!s.trim()) {
    throw new Error(`auggieRouter.${key}: must be a non-empty string`);
  }
  return s;
}

function assertBool(val: unknown, key: string): boolean {
  if (typeof val !== "boolean") {
    throw new Error(`auggieRouter.${key}: expected boolean, got ${typeof val}`);
  }
  return val;
}

function assertEnum<T extends string>(
  val: unknown,
  key: string,
  allowed: ReadonlySet<T>
): T {
  const s = assertString(val, key);
  if (!(allowed as ReadonlySet<string>).has(s)) {
    const list = Array.from(allowed).join("|");
    throw new Error(`auggieRouter.${key}: must be one of ${list}, got "${s}"`);
  }
  return s as T;
}

function validateExecutionRoutingModels(
  raw: unknown,
  warnings: string[]
): Partial<Record<ExecutionRoutingTier, string>> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.executionRouting.models: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const out: Partial<Record<ExecutionRoutingTier, string>> = {};
  for (const [tier, model] of Object.entries(raw as Record<string, unknown>)) {
    if (!(TIER_VALUES as ReadonlySet<string>).has(tier)) {
      warnings.push(
        `auggieRouter.executionRouting.models.${tier}: unknown tier (allowed: cheap|balanced|frontier)`
      );
      continue;
    }
    try {
      out[tier as ExecutionRoutingTier] = assertNonEmptyString(
        model,
        `executionRouting.models.${tier}`
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return out;
}

function validateExecutionRouting(
  raw: unknown,
  warnings: string[]
): ExecutionRoutingSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.executionRouting: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: ExecutionRoutingSettings = {
    ...DEFAULT_EXECUTION_ROUTING,
    models: { ...DEFAULT_EXECUTION_ROUTING.models },
  };
  if ("enabled" in r) {
    try {
      out.enabled = assertBool(r.enabled, "executionRouting.enabled");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("preference" in r) {
    try {
      out.preference = assertEnum(
        r.preference,
        "executionRouting.preference",
        PREFERENCE_VALUES
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("surfaceDecision" in r) {
    try {
      out.surfaceDecision = assertBool(
        r.surfaceDecision,
        "executionRouting.surfaceDecision"
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("skillModelPolicy" in r) {
    try {
      out.skillModelPolicy = assertEnum(
        r.skillModelPolicy,
        "executionRouting.skillModelPolicy",
        POLICY_VALUES
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("models" in r) {
    const validated = validateExecutionRoutingModels(r.models, warnings);
    if (validated !== undefined) {
      out.models = { ...DEFAULT_EXECUTION_ROUTING.models, ...validated };
    }
  }
  return out;
}

function validateOutputSanitizer(
  raw: unknown,
  warnings: string[]
): OutputSanitizerSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.outputSanitizer: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: OutputSanitizerSettings = { ...DEFAULT_OUTPUT_SANITIZER };
  if ("enabled" in r) {
    try {
      out.enabled = assertBool(r.enabled, "outputSanitizer.enabled");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("finalOutputMaxChars" in r) {
    try {
      out.finalOutputMaxChars = assertInt(
        r.finalOutputMaxChars,
        "outputSanitizer.finalOutputMaxChars",
        0,
        10_000_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("stripToolTraces" in r) {
    try {
      out.stripToolTraces = assertBool(
        r.stripToolTraces,
        "outputSanitizer.stripToolTraces"
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return out;
}

function validateContextBudgetCeilings(
  raw: unknown,
  warnings: string[]
): Partial<Record<ExecutionRoutingTier, number>> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.contextBudgets.overflowCeilingBytes: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const out: Partial<Record<ExecutionRoutingTier, number>> = {};
  for (const [tier, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(TIER_VALUES as ReadonlySet<string>).has(tier)) {
      warnings.push(
        `auggieRouter.contextBudgets.overflowCeilingBytes.${tier}: unknown tier (allowed: cheap|balanced|frontier)`
      );
      continue;
    }
    try {
      out[tier as ExecutionRoutingTier] = assertInt(
        value,
        `contextBudgets.overflowCeilingBytes.${tier}`,
        1_000,
        10_000_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return out;
}

function validateContextBudgets(
  raw: unknown,
  warnings: string[]
): ContextBudgetSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.contextBudgets: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: ContextBudgetSettings = {
    ...DEFAULT_CONTEXT_BUDGETS,
    overflowCeilingBytes: { ...DEFAULT_CONTEXT_BUDGETS.overflowCeilingBytes },
  };
  if ("enabled" in r) {
    try {
      out.enabled = assertBool(r.enabled, "contextBudgets.enabled");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("overflowCeilingBytes" in r) {
    const validated = validateContextBudgetCeilings(
      r.overflowCeilingBytes,
      warnings
    );
    if (validated !== undefined) {
      // Respect user intent: a partially-specified pool intentionally omits
      // tiers. Missing tiers fall through to the top-level overflow ceiling
      // at selection time (source: "tier-fallback").
      out.overflowCeilingBytes = { ...validated };
    }
  }
  return out;
}

function validateHistoryAssembly(
  raw: unknown,
  warnings: string[]
): HistoryAssemblySettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.historyAssembly: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: HistoryAssemblySettings = { ...DEFAULT_HISTORY_ASSEMBLY };
  if ("strategy" in r) {
    try {
      out.strategy = assertEnum(
        r.strategy,
        "historyAssembly.strategy",
        HISTORY_STRATEGY_VALUES
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("headMessages" in r) {
    try {
      out.headMessages = assertInt(
        r.headMessages,
        "historyAssembly.headMessages",
        0,
        500
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("tailMessages" in r) {
    try {
      out.tailMessages = assertInt(
        r.tailMessages,
        "historyAssembly.tailMessages",
        0,
        500
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("middleMode" in r) {
    try {
      out.middleMode = assertEnum(
        r.middleMode,
        "historyAssembly.middleMode",
        HISTORY_MIDDLE_MODE_VALUES
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("maxCharsPerMessage" in r) {
    try {
      out.maxCharsPerMessage = assertInt(
        r.maxCharsPerMessage,
        "historyAssembly.maxCharsPerMessage",
        0,
        1_000_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("maxTotalChars" in r) {
    try {
      out.maxTotalChars = assertInt(
        r.maxTotalChars,
        "historyAssembly.maxTotalChars",
        0,
        10_000_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return out;
}

function validateContextMemory(
  raw: unknown,
  warnings: string[]
): ContextMemorySettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.contextMemory: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: ContextMemorySettings = { ...DEFAULT_CONTEXT_MEMORY };
  if ("enabled" in r) {
    try {
      out.enabled = assertBool(r.enabled, "contextMemory.enabled");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("maxEntries" in r) {
    try {
      out.maxEntries = assertInt(r.maxEntries, "contextMemory.maxEntries", 1, 1_000);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("maxBytesPerRun" in r) {
    try {
      out.maxBytesPerRun = assertInt(
        r.maxBytesPerRun,
        "contextMemory.maxBytesPerRun",
        1_000,
        100_000_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("previewHeadChars" in r) {
    try {
      out.previewHeadChars = assertInt(
        r.previewHeadChars,
        "contextMemory.previewHeadChars",
        0,
        100_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("previewTailChars" in r) {
    try {
      out.previewTailChars = assertInt(
        r.previewTailChars,
        "contextMemory.previewTailChars",
        0,
        100_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return out;
}

function validateParallelSubagents(
  raw: unknown,
  warnings: string[]
): ParallelSubagentsSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.parallelSubagents: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: ParallelSubagentsSettings = { ...DEFAULT_PARALLEL_SUBAGENTS };
  if ("enabled" in r) {
    try {
      out.enabled = assertBool(r.enabled, "parallelSubagents.enabled");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("maxSubagents" in r) {
    try {
      out.maxSubagents = assertInt(
        r.maxSubagents,
        "parallelSubagents.maxSubagents",
        1,
        16
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("perWorkerOutputCharCap" in r) {
    try {
      out.perWorkerOutputCharCap = assertInt(
        r.perWorkerOutputCharCap,
        "parallelSubagents.perWorkerOutputCharCap",
        0,
        1_000_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return out;
}

function validateExecutionTrace(
  raw: unknown,
  warnings: string[]
): ExecutionTraceSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(
      `auggieRouter.executionTrace: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: ExecutionTraceSettings = { ...DEFAULT_EXECUTION_TRACE };
  if ("enabled" in r) {
    try {
      out.enabled = assertBool(r.enabled, "executionTrace.enabled");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("maxResultPreviewChars" in r) {
    try {
      out.maxResultPreviewChars = assertInt(
        r.maxResultPreviewChars,
        "executionTrace.maxResultPreviewChars",
        100,
        100_000
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("traceDirectory" in r) {
    try {
      out.traceDirectory = assertNonEmptyString(r.traceDirectory, "executionTrace.traceDirectory");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return out;
}

function assertNonEmptyStringArray(val: unknown, key: string): string[] {
  if (!Array.isArray(val)) {
    throw new Error(`auggieRouter.${key}: expected string[], got ${typeof val}`);
  }
  const result: string[] = [];
  for (let i = 0; i < val.length; i++) {
    const item = val[i];
    if (typeof item !== "string") {
      throw new Error(`auggieRouter.${key}[${i}]: expected string, got ${typeof item}`);
    }
    if (!item.trim()) {
      throw new Error(`auggieRouter.${key}[${i}]: must be a non-empty string`);
    }
    result.push(item.trim());
  }
  return result;
}

/**
 * Validate a raw `auggieRouter` object from `.pi/settings.json`, returning
 * a safe `Partial<RouterSettings>`. Invalid fields are silently dropped so
 * the router still works — but every problem is logged so the user can fix
 * their config.
 */
function validateSettings(
  raw: Record<string, unknown>,
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void
): Partial<RouterSettings> {
  const out: Partial<RouterSettings> = {};
  const warnings: string[] = [];

  if ("defaultProvider" in raw) {
    try {
      out.defaultProvider = assertNonEmptyString(raw.defaultProvider, "defaultProvider");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("routingModel" in raw) {
    try {
      out.routingModel = assertNonEmptyString(raw.routingModel, "routingModel");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("historyWindow" in raw) {
    try {
      out.historyWindow = assertInt(raw.historyWindow, "historyWindow", 1, 500);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("maxJudgeIterations" in raw) {
    try {
      out.maxJudgeIterations = assertInt(raw.maxJudgeIterations, "maxJudgeIterations", 0, 10);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("routingTimeoutMs" in raw) {
    try {
      out.routingTimeoutMs = assertInt(raw.routingTimeoutMs, "routingTimeoutMs", 10, 600_000);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("qaTimeoutMs" in raw) {
    try {
      out.qaTimeoutMs = assertInt(raw.qaTimeoutMs, "qaTimeoutMs", 10, 3_600_000);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("totalTimeoutMs" in raw) {
    try {
      out.totalTimeoutMs = assertInt(raw.totalTimeoutMs, "totalTimeoutMs", 10_000, 3_600_000);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("inactivityTimeoutMs" in raw) {
    try {
      out.inactivityTimeoutMs = assertInt(raw.inactivityTimeoutMs, "inactivityTimeoutMs", 5_000, 600_000);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("subAgentTemperature" in raw) {
    try {
      const t = assertNumber(raw.subAgentTemperature, "subAgentTemperature");
      if (!Number.isFinite(t)) {
        throw new Error("auggieRouter.subAgentTemperature: must be a finite number");
      }
      if (t < 0 || t > 2) {
        throw new Error("auggieRouter.subAgentTemperature: must be between 0 and 2");
      }
      out.subAgentTemperature = t;
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("overflowCeilingBytes" in raw) {
    try {
      out.overflowCeilingBytes = assertInt(raw.overflowCeilingBytes, "overflowCeilingBytes", 1_000, 10_000_000);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("auggieBinPath" in raw) {
    try {
      out.auggieBinPath = assertNonEmptyString(raw.auggieBinPath, "auggieBinPath");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("allowedProviderPrefixes" in raw) {
    try {
      out.allowedProviderPrefixes = assertNonEmptyStringArray(raw.allowedProviderPrefixes, "allowedProviderPrefixes");
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("executionRouting" in raw) {
    const validated = validateExecutionRouting(raw.executionRouting, warnings);
    if (validated !== undefined) {
      out.executionRouting = validated;
    }
  }
  if ("debugPromptPrefixHash" in raw) {
    try {
      out.debugPromptPrefixHash = assertBool(
        raw.debugPromptPrefixHash,
        "debugPromptPrefixHash"
      );
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if ("outputSanitizer" in raw) {
    const validated = validateOutputSanitizer(raw.outputSanitizer, warnings);
    if (validated !== undefined) {
      out.outputSanitizer = validated;
    }
  }
  if ("contextBudgets" in raw) {
    const validated = validateContextBudgets(raw.contextBudgets, warnings);
    if (validated !== undefined) {
      out.contextBudgets = validated;
    }
  }
  if ("historyAssembly" in raw) {
    const validated = validateHistoryAssembly(raw.historyAssembly, warnings);
    if (validated !== undefined) {
      out.historyAssembly = validated;
    }
  }
  if ("contextMemory" in raw) {
    const validated = validateContextMemory(raw.contextMemory, warnings);
    if (validated !== undefined) {
      out.contextMemory = validated;
    }
  }
  if ("parallelSubagents" in raw) {
    const validated = validateParallelSubagents(raw.parallelSubagents, warnings);
    if (validated !== undefined) {
      out.parallelSubagents = validated;
    }
  }
  if ("executionTrace" in raw) {
    const validated = validateExecutionTrace(raw.executionTrace, warnings);
    if (validated !== undefined) {
      out.executionTrace = validated;
    }
  }

  for (const w of warnings) {
    log("warn", `pi-auggie-router: invalid setting ignored — ${w}`);
  }

  return out;
}

export function loadSettings(host: PiHost): RouterSettings {
  const path = host.resolveWorkspacePath(".pi/settings.json");
  if (!existsSync(path)) {
    return cloneDefaultSettings();
  }
  const log = host.log ?? (() => {});
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PiSettingsFile;
    const raw = parsed.auggieRouter ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      log(
        "warn",
        `pi-auggie-router: auggieRouter in .pi/settings.json must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}; using defaults.`
      );
      return cloneDefaultSettings();
    }
    const validated = validateSettings(
      raw as Record<string, unknown>,
      log as (level: "debug" | "info" | "warn" | "error", msg: string) => void
    );
    return mergeSettings(validated);
  } catch (err) {
    log(
      "warn",
      `pi-auggie-router: failed to parse .pi/settings.json (${(err as Error).message}); using defaults.`
    );
    return cloneDefaultSettings();
  }
}
