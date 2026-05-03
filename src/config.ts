import { readFileSync, existsSync } from "node:fs";
import type { PiHost, RouterSettings } from "./types.js";

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
};

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
  if (!Number.isFinite(n) || n < min || n > max) {
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

function assertStringArray(val: unknown, key: string): string[] {
  if (!Array.isArray(val)) {
    throw new Error(`auggieRouter.${key}: expected string[], got ${typeof val}`);
  }
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== "string") {
      throw new Error(`auggieRouter.${key}[${i}]: expected string, got ${typeof val[i]}`);
    }
  }
  return val as string[];
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
      out.allowedProviderPrefixes = assertStringArray(raw.allowedProviderPrefixes, "allowedProviderPrefixes");
    } catch (e) {
      warnings.push((e as Error).message);
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
    return { ...DEFAULT_SETTINGS };
  }
  const noop = () => {};
  const log = host.log ?? (() => {});
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PiSettingsFile;
    const raw = parsed.auggieRouter ?? {};
    const validated = validateSettings(
      raw as Record<string, unknown>,
      log as (level: "debug" | "info" | "warn" | "error", msg: string) => void
    );
    return { ...DEFAULT_SETTINGS, ...validated };
  } catch (err) {
    log(
      "warn",
      `pi-auggie-router: failed to parse .pi/settings.json (${(err as Error).message}); using defaults.`
    );
    return { ...DEFAULT_SETTINGS };
  }
}
