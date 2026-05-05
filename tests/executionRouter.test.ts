import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseExecutionModel } from "../src/executionRouter.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { DisallowedProviderError } from "../src/modelMapper.ts";
import type {
  ExecutionRoute,
  ExecutionRoutingTier,
  ParsedSkill,
  RouterSettings,
} from "../src/types.ts";

function makeSkill(rawModel?: string): ParsedSkill {
  return {
    name: "demo",
    filePath: "/tmp/SKILL.md",
    rawModel,
    instructions: "Demo skill body.",
  };
}

function makeRoute(over: Partial<ExecutionRoute> = {}): ExecutionRoute {
  return {
    tier: "balanced",
    complexity: "medium",
    risk: "small_edit",
    confidence: 0.8,
    reason: "test",
    ...over,
  };
}

function withRouting(over: Partial<RouterSettings["executionRouting"]> = {}): RouterSettings {
  return {
    ...DEFAULT_SETTINGS,
    allowedProviderPrefixes: [...DEFAULT_SETTINGS.allowedProviderPrefixes],
    executionRouting: {
      ...DEFAULT_SETTINGS.executionRouting,
      ...over,
      models: {
        ...DEFAULT_SETTINGS.executionRouting.models,
        ...(over.models ?? {}),
      },
    },
  };
}

describe("chooseExecutionModel — disabled mode (legacy)", () => {
  it("uses SKILL.md model when set", () => {
    const out = chooseExecutionModel({
      skill: makeSkill("anthropic/claude-3-7-sonnet"),
      route: makeRoute({ tier: "cheap" }),
      settings: withRouting({ enabled: false }),
    });
    assert.equal(out.source, "skill-model");
    assert.equal(out.model, "openrouter/anthropic/claude-3-7-sonnet");
  });

  it("falls back to default when SKILL.md has no model", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({ tier: "cheap" }),
      settings: withRouting({ enabled: false }),
    });
    assert.equal(out.source, "fallback");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-sonnet");
  });
});

describe("chooseExecutionModel — pin policy", () => {
  it("honours SKILL.md model exactly when policy=pin", () => {
    const out = chooseExecutionModel({
      skill: makeSkill("anthropic/claude-3-5-haiku"),
      route: makeRoute({ tier: "frontier" }),
      settings: withRouting({ enabled: true, skillModelPolicy: "pin" }),
    });
    assert.equal(out.source, "skill-model");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-haiku");
  });

  it("falls through to adaptive when pin set but SKILL.md has no model", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({ tier: "cheap", risk: "read_only" }),
      settings: withRouting({ enabled: true, skillModelPolicy: "pin" }),
    });
    assert.equal(out.source, "execution-routing");
    assert.equal(out.tier, "cheap");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-haiku");
  });
});

describe("chooseExecutionModel — ignore policy overrides SKILL.md", () => {
  it("ignores SKILL.md model when policy=ignore", () => {
    const out = chooseExecutionModel({
      skill: makeSkill("anthropic/some-pinned-model"),
      route: makeRoute({ tier: "cheap", risk: "read_only" }),
      settings: withRouting({ enabled: true, skillModelPolicy: "ignore" }),
    });
    assert.equal(out.source, "execution-routing");
    assert.equal(out.tier, "cheap");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-haiku");
  });
});

describe("chooseExecutionModel — preference adjustment", () => {
  it("preferCheap downgrades balanced→cheap on safe medium tasks with high confidence", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "balanced",
        complexity: "medium",
        risk: "small_edit",
        confidence: 0.8,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "preferCheap",
      }),
    });
    assert.equal(out.tier, "cheap");
  });

  it("preferCheap leaves balanced alone when confidence < 0.7", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "balanced",
        complexity: "medium",
        risk: "small_edit",
        confidence: 0.5,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "preferCheap",
      }),
    });
    assert.equal(out.tier, "balanced");
  });

  it("preferCheap will not downgrade multi_file_edit risk", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "balanced",
        complexity: "medium",
        risk: "multi_file_edit",
        confidence: 0.95,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "preferCheap",
      }),
    });
    assert.equal(out.tier, "balanced");
  });

  it("preferBest upgrades cheap edit tasks to balanced", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "cheap",
        complexity: "low",
        risk: "small_edit",
        confidence: 0.9,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "preferBest",
      }),
    });
    assert.equal(out.tier, "balanced");
  });

  it("preferBest upgrades unknown-risk tasks to frontier", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "balanced",
        complexity: "high",
        risk: "unknown",
        confidence: 0.4,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "preferBest",
      }),
    });
    assert.equal(out.tier, "frontier");
  });
});

describe("chooseExecutionModel — safety floors", () => {
  it("architecture_change forces frontier even under preferCheap", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "cheap",
        complexity: "high",
        risk: "architecture_change",
        confidence: 0.95,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "preferCheap",
      }),
    });
    assert.equal(out.tier, "frontier");
  });

  it("multi_file_edit pulls cheap floor up to balanced", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "cheap",
        complexity: "medium",
        risk: "multi_file_edit",
        confidence: 0.9,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "balanced",
      }),
    });
    assert.equal(out.tier, "balanced");
  });

  it("unknown risk + low confidence pulls cheap floor up to balanced", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({
        tier: "cheap",
        complexity: "medium",
        risk: "unknown",
        confidence: 0.3,
      }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        preference: "balanced",
      }),
    });
    assert.equal(out.tier, "balanced");
  });
});

describe("chooseExecutionModel — pool resolution", () => {
  it("walks the missing-pool fallback chain", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({ tier: "cheap", risk: "read_only" }),
      settings: withRouting({
        enabled: true,
        skillModelPolicy: "ignore",
        models: {
          // No `cheap` configured. Chain: cheap → balanced → frontier.
          cheap: undefined,
          balanced: "anthropic/claude-3-5-sonnet",
          frontier: "anthropic/claude-3-7-sonnet",
        },
      }),
    });
    assert.equal(out.tier, "balanced");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-sonnet");
  });

  it("respects allowedProviderPrefixes on pool models and falls back", () => {
    const settings: RouterSettings = {
      ...DEFAULT_SETTINGS,
      allowedProviderPrefixes: ["openrouter"],
      executionRouting: {
        ...DEFAULT_SETTINGS.executionRouting,
        enabled: true,
        skillModelPolicy: "ignore",
        models: {
          cheap: "evil/anthropic/claude-x",
          balanced: "openrouter/anthropic/claude-3-5-sonnet",
          frontier: "openrouter/anthropic/claude-3-7-sonnet",
        },
      },
    };
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({ tier: "cheap", risk: "read_only" }),
      settings,
    });
    assert.equal(out.tier, "balanced");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-sonnet");
  });

  it("falls back to legacy mapModel when the entire pool is unusable", () => {
    const settings: RouterSettings = {
      ...DEFAULT_SETTINGS,
      allowedProviderPrefixes: ["openrouter"],
      executionRouting: {
        ...DEFAULT_SETTINGS.executionRouting,
        enabled: true,
        skillModelPolicy: "ignore",
        models: {
          cheap: "evil/anthropic/claude-x",
          balanced: "evil/anthropic/claude-y",
          frontier: "evil/anthropic/claude-z",
        },
      },
    };
    const out = chooseExecutionModel({
      // raw model is a 2-segment vendor/model, mapModel prefixes "openrouter/"
      // which satisfies the allowlist and lets the legacy fallback succeed.
      skill: makeSkill("anthropic/claude-3-5-haiku"),
      route: makeRoute({ tier: "cheap", risk: "read_only" }),
      settings,
    });
    assert.equal(out.source, "fallback");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-haiku");
  });

  it("propagates DisallowedProviderError when even the legacy fallback rawModel is rejected", () => {
    const settings: RouterSettings = {
      ...DEFAULT_SETTINGS,
      allowedProviderPrefixes: ["openrouter"],
      executionRouting: {
        ...DEFAULT_SETTINGS.executionRouting,
        enabled: true,
        skillModelPolicy: "ignore",
        models: {
          cheap: "evil/anthropic/x",
          balanced: "evil/anthropic/y",
          frontier: "evil/anthropic/z",
        },
      },
    };
    assert.throws(
      () =>
        chooseExecutionModel({
          skill: makeSkill("evil-vendor/anthropic/m"),
          route: makeRoute({ tier: "cheap", risk: "read_only" }),
          settings,
        }),
      DisallowedProviderError
    );
  });
});

describe("chooseExecutionModel — undefined route", () => {
  it("treats missing route as the default balanced/unknown route", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: undefined,
      settings: withRouting({ enabled: true, skillModelPolicy: "ignore" }),
    });
    // unknown risk + confidence=0 → safety floor pulls cheap→balanced; baseline
    // is already balanced so result is balanced.
    assert.equal(out.tier, "balanced");
    assert.equal(out.model, "openrouter/anthropic/claude-3-5-sonnet");
  });
});

describe("chooseExecutionModel — sticky output shape", () => {
  it("returns a primitive-only payload safe for logs", () => {
    const out = chooseExecutionModel({
      skill: makeSkill(undefined),
      route: makeRoute({ tier: "cheap", risk: "read_only" }),
      settings: withRouting({ enabled: true, skillModelPolicy: "ignore" }),
    });
    const expectedTiers: ExecutionRoutingTier[] = ["cheap", "balanced", "frontier"];
    assert.ok(expectedTiers.includes(out.tier));
    assert.equal(typeof out.model, "string");
    assert.equal(typeof out.reason, "string");
    assert.ok(["skill-model", "execution-routing", "fallback"].includes(out.source));
  });
});
