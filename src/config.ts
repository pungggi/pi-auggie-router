import { readFileSync, existsSync } from "node:fs";
import type {
  ExecutionRoutingPreference,
  ExecutionRoutingSettings,
  ExecutionRoutingTier,
  PiHost,
  RouterSettings,
  SkillModelPolicy,
} from "./types.js";

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
};

function cloneExecutionRouting(
  settings: ExecutionRoutingSettings = DEFAULT_EXECUTION_ROUTING
): ExecutionRoutingSettings {
  return {
    ...settings,
    models: { ...settings.models },
  };
}

function cloneDefaultSettings(): RouterSettings {
  return {
    ...DEFAULT_SETTINGS,
    allowedProviderPrefixes: [...DEFAULT_SETTINGS.allowedProviderPrefixes],
    executionRouting: cloneExecutionRouting(),
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
      out.maxJudgeIterations = assertInt(raw.maxJudgeIterations, "maxJudgeIterations", 1, 10);
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
