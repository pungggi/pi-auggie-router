import { readFileSync, existsSync } from "node:fs";
import type { PiHost, RouterSettings } from "./types.js";

export const DEFAULT_SETTINGS: RouterSettings = {
  defaultProvider: "openrouter",
  routingModel: "anthropic/claude-3-5-haiku",
  historyWindow: 20,
  maxJudgeIterations: 2,
  routingTimeoutMs: 60_000,
  routingMaxRetries: 2,
  routingRetryBaseDelayMs: 250,
  qaTimeoutMs: 300_000,
  totalTimeoutMs: 300_000,
  inactivityTimeoutMs: 60_000,
  subAgentTemperature: 0.0,
  overflowCeilingBytes: 25_000,
  overflowFloorBytes: 5_000,
};

interface PiSettingsFile {
  auggieRouter?: Record<string, unknown>;
}

/**
 * Merge user overrides onto the defaults, keeping only values of the right
 * shape: strings must be non-blank, numbers must be finite and >= 0 (0 keeps
 * its "disabled" meaning for the timeout knobs). Anything else — strings
 * where numbers belong, negatives, null — falls back to the default so a
 * typo in `.pi/settings.json` can't produce NaN arithmetic or unbounded
 * retry loops downstream.
 */
function sanitizeSettings(
  overrides: Record<string, unknown>,
  host: PiHost
): RouterSettings {
  const out: Record<string, string | number> = { ...DEFAULT_SETTINGS };
  const rejected: string[] = [];
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in overrides)) continue;
    const v = overrides[key];
    if (typeof def === "number") {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        out[key] = v;
      } else {
        rejected.push(key);
      }
    } else {
      if (typeof v === "string" && v.trim()) {
        out[key] = v;
      } else {
        rejected.push(key);
      }
    }
  }
  if (rejected.length) {
    host.log?.(
      "warn",
      `pi-auggie-router: ignored invalid auggieRouter settings (${rejected.join(", ")}); using defaults for those.`
    );
  }
  return out as unknown as RouterSettings;
}

export function loadSettings(host: PiHost): RouterSettings {
  const path = host.resolveWorkspacePath(".pi/settings.json");
  if (!existsSync(path)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PiSettingsFile;
    return sanitizeSettings(parsed.auggieRouter ?? {}, host);
  } catch (err) {
    host.log?.(
      "warn",
      `pi-auggie-router: failed to parse .pi/settings.json (${(err as Error).message}); using defaults.`
    );
    return { ...DEFAULT_SETTINGS };
  }
}
