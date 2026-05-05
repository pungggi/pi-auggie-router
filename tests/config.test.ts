import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXECUTION_ROUTING, DEFAULT_SETTINGS, loadSettings } from "../src/config.ts";
import type { ChatMessage, LLMCallOptions, PiHost, SubAgentRunOptions, SubAgentResult } from "../src/types.ts";

function fakeHost(workspace: string): { host: PiHost; warnings: string[] } {
  const warnings: string[] = [];
  const host: PiHost = {
    postSystemMessage: () => {},
    postAssistantMessage: () => {},
    setInputLocked: () => {},
    getRecentMessages: (): ChatMessage[] => [],
    callLLM: async (_opts: LLMCallOptions) => ({ text: "" }),
    runSubAgent: async (_opts: SubAgentRunOptions): Promise<SubAgentResult> => ({
      finalText: "",
      stoppedReason: "completed",
    }),
    onBeforeMessage: () => () => {},
    onUserInput: () => () => {},
    resolveWorkspacePath: (rel: string) => join(workspace, rel),
    resolveHomePath: (rel: string) => join(workspace, rel),
    log: (level, msg) => {
      if (level === "warn" || level === "error") warnings.push(msg);
    },
  };
  return { host, warnings };
}

function withWorkspace(settings: unknown | undefined): { workspace: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), "pi-router-cfg-"));
  if (settings !== undefined) {
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(
      join(workspace, ".pi", "settings.json"),
      JSON.stringify({ auggieRouter: settings })
    );
  }
  return { workspace, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

describe("config — executionRouting defaults", () => {
  it("DEFAULT_SETTINGS includes executionRouting disabled with full pool", () => {
    assert.equal(DEFAULT_SETTINGS.executionRouting.enabled, false);
    assert.equal(DEFAULT_SETTINGS.executionRouting.preference, "balanced");
    assert.equal(DEFAULT_SETTINGS.executionRouting.surfaceDecision, false);
    assert.equal(DEFAULT_SETTINGS.executionRouting.skillModelPolicy, "pin");
    assert.equal(DEFAULT_SETTINGS.executionRouting.models.cheap, "anthropic/claude-3-5-haiku");
    assert.equal(DEFAULT_SETTINGS.executionRouting.models.balanced, "anthropic/claude-3-5-sonnet");
    assert.equal(DEFAULT_SETTINGS.executionRouting.models.frontier, "anthropic/claude-3-7-sonnet");
  });

  it("loadSettings without file returns defaults including executionRouting", () => {
    const { workspace, cleanup } = withWorkspace(undefined);
    try {
      const { host } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.deepEqual(s.executionRouting, DEFAULT_EXECUTION_ROUTING);
    } finally {
      cleanup();
    }
  });

  it("loadSettings returns fresh nested defaults to avoid shared mutation", () => {
    const { workspace, cleanup } = withWorkspace(undefined);
    try {
      const { host } = fakeHost(workspace);
      const first = loadSettings(host);
      first.executionRouting.enabled = true;
      first.executionRouting.models.cheap = "mutated/provider/model";
      first.allowedProviderPrefixes.push("mutated");

      const second = loadSettings(host);
      assert.equal(second.executionRouting.enabled, false);
      assert.equal(second.executionRouting.models.cheap, "anthropic/claude-3-5-haiku");
      assert.deepEqual(second.allowedProviderPrefixes, []);
      assert.notEqual(first.executionRouting, second.executionRouting);
      assert.notEqual(first.executionRouting.models, second.executionRouting.models);
      assert.notEqual(first.allowedProviderPrefixes, second.allowedProviderPrefixes);
    } finally {
      cleanup();
    }
  });
});

describe("config — executionRouting validation", () => {
  it("accepts a full valid override", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: {
        enabled: true,
        preference: "preferCheap",
        surfaceDecision: true,
        skillModelPolicy: "ignore",
        models: {
          cheap: "anthropic/claude-3-5-haiku",
          balanced: "anthropic/claude-3-5-sonnet",
          frontier: "anthropic/claude-3-7-sonnet",
        },
      },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.enabled, true);
      assert.equal(s.executionRouting.preference, "preferCheap");
      assert.equal(s.executionRouting.surfaceDecision, true);
      assert.equal(s.executionRouting.skillModelPolicy, "ignore");
      assert.equal(warnings.length, 0);
    } finally {
      cleanup();
    }
  });

  it("partial override merges with defaults", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: { enabled: true },
    });
    try {
      const { host } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.enabled, true);
      assert.equal(s.executionRouting.preference, "balanced");
      assert.equal(s.executionRouting.skillModelPolicy, "pin");
      assert.equal(s.executionRouting.models.balanced, "anthropic/claude-3-5-sonnet");
    } finally {
      cleanup();
    }
  });

  it("rejects invalid preference and falls back to default", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: { preference: "wild" },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.preference, "balanced");
      assert.ok(warnings.some((w) => w.includes("executionRouting.preference")));
    } finally {
      cleanup();
    }
  });

  it("rejects invalid skillModelPolicy and warns", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: { skillModelPolicy: "bogus" },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.skillModelPolicy, "pin");
      assert.ok(warnings.some((w) => w.includes("executionRouting.skillModelPolicy")));
    } finally {
      cleanup();
    }
  });

  it("defers skillModelPolicy=prefer until the policy is implemented", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: { skillModelPolicy: "prefer" },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.skillModelPolicy, "pin");
      assert.ok(warnings.some((w) => w.includes("executionRouting.skillModelPolicy")));
    } finally {
      cleanup();
    }
  });

  it("rejects non-boolean enabled and warns", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: { enabled: "yes" },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.enabled, false);
      assert.ok(warnings.some((w) => w.includes("executionRouting.enabled")));
    } finally {
      cleanup();
    }
  });

  it("drops unknown tier keys with a warning, keeps valid tiers", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: {
        models: {
          cheap: "anthropic/claude-3-5-haiku",
          mystery: "anthropic/claude-x",
        },
      },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.models.cheap, "anthropic/claude-3-5-haiku");
      assert.equal((s.executionRouting.models as Record<string, string>).mystery, undefined);
      assert.ok(warnings.some((w) => w.includes("executionRouting.models.mystery")));
    } finally {
      cleanup();
    }
  });

  it("rejects non-string tier model and warns", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: { models: { balanced: 42 } },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.equal(s.executionRouting.models.balanced, "anthropic/claude-3-5-sonnet");
      assert.ok(warnings.some((w) => w.includes("executionRouting.models.balanced")));
    } finally {
      cleanup();
    }
  });

  it("rejects non-object executionRouting and falls back", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: "off",
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.deepEqual(s.executionRouting, DEFAULT_EXECUTION_ROUTING);
      assert.ok(warnings.some((w) => w.includes("executionRouting:")));
    } finally {
      cleanup();
    }
  });

  it("rejects array models field and falls back", () => {
    const { workspace, cleanup } = withWorkspace({
      executionRouting: { models: ["a", "b"] },
    });
    try {
      const { host, warnings } = fakeHost(workspace);
      const s = loadSettings(host);
      assert.deepEqual(s.executionRouting.models, DEFAULT_EXECUTION_ROUTING.models);
      assert.ok(warnings.some((w) => w.includes("executionRouting.models")));
    } finally {
      cleanup();
    }
  });
});
