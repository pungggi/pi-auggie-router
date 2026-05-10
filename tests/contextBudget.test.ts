import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseContextBudget } from "../src/contextBudget.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import type { RouterSettings } from "../src/types.ts";

function makeSettings(overrides: Partial<RouterSettings> = {}): RouterSettings {
  return {
    ...DEFAULT_SETTINGS,
    contextBudgets: {
      enabled: false,
      overflowCeilingBytes: { ...DEFAULT_SETTINGS.contextBudgets.overflowCeilingBytes },
    },
    ...overrides,
  };
}

describe("chooseContextBudget", () => {
  it("returns top-level ceiling when disabled (source=static)", () => {
    const s = makeSettings({ overflowCeilingBytes: 25_000 });
    const r = chooseContextBudget(s, "cheap");
    assert.equal(r.overflowCeilingBytes, 25_000);
    assert.equal(r.active, false);
    assert.equal(r.source, "static");
    assert.equal(r.tier, "cheap");
  });

  it("returns cheap-tier ceiling when enabled", () => {
    const s = makeSettings({
      overflowCeilingBytes: 25_000,
      contextBudgets: {
        enabled: true,
        overflowCeilingBytes: { cheap: 15_000, balanced: 25_000, frontier: 50_000 },
      },
    });
    const r = chooseContextBudget(s, "cheap");
    assert.equal(r.overflowCeilingBytes, 15_000);
    assert.equal(r.source, "tier");
    assert.equal(r.tier, "cheap");
    assert.equal(r.active, true);
  });

  it("returns balanced-tier ceiling when enabled", () => {
    const s = makeSettings({
      contextBudgets: {
        enabled: true,
        overflowCeilingBytes: { cheap: 15_000, balanced: 25_000, frontier: 50_000 },
      },
    });
    const r = chooseContextBudget(s, "balanced");
    assert.equal(r.overflowCeilingBytes, 25_000);
    assert.equal(r.source, "tier");
  });

  it("returns frontier-tier ceiling when enabled", () => {
    const s = makeSettings({
      contextBudgets: {
        enabled: true,
        overflowCeilingBytes: { cheap: 15_000, balanced: 25_000, frontier: 50_000 },
      },
    });
    const r = chooseContextBudget(s, "frontier");
    assert.equal(r.overflowCeilingBytes, 50_000);
    assert.equal(r.source, "tier");
  });

  it("falls back to top-level when tier value missing", () => {
    const s = makeSettings({
      overflowCeilingBytes: 25_000,
      contextBudgets: {
        enabled: true,
        overflowCeilingBytes: { balanced: 40_000 },
      },
    });
    const r = chooseContextBudget(s, "frontier");
    assert.equal(r.overflowCeilingBytes, 25_000);
    assert.equal(r.source, "tier-fallback");
    assert.equal(r.tier, "frontier");
    assert.equal(r.active, true);
  });
});
