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
};

interface PiSettingsFile {
  auggieRouter?: Partial<RouterSettings>;
}

export function loadSettings(host: PiHost): RouterSettings {
  const path = host.resolveWorkspacePath(".pi/settings.json");
  if (!existsSync(path)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PiSettingsFile;
    return { ...DEFAULT_SETTINGS, ...(parsed.auggieRouter ?? {}) };
  } catch (err) {
    host.log?.(
      "warn",
      `pi-auggie-router: failed to parse .pi/settings.json (${(err as Error).message}); using defaults.`
    );
    return { ...DEFAULT_SETTINGS };
  }
}
