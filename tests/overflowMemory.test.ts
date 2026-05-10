import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUGGIE_MCP_NAME,
  AUGGIE_TOOL_NAME,
  makeOverflowMiddleware,
} from "../src/auggie.ts";
import { ContextMemoryStore } from "../src/contextMemory.ts";
import { DEFAULT_CONTEXT_MEMORY, DEFAULT_SETTINGS } from "../src/config.ts";
import { executeSkill } from "../src/subAgent.ts";
import type {
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
  SubAgentRunOptions,
} from "../src/types.ts";

function ctx() {
  return {
    serverName: AUGGIE_MCP_NAME,
    toolName: AUGGIE_TOOL_NAME,
    args: {},
  };
}

describe("makeOverflowMiddleware — context memory integration", () => {
  it("falls back to legacy message when no store is provided", () => {
    const mw = makeOverflowMiddleware(100);
    const result = mw(ctx(), "x".repeat(200));
    assert.equal(result.block, true);
    if (result.block) {
      assert.match(result.replacement, /refine your codebase-retrieval query/);
      assert.doesNotMatch(result.replacement, /overflow_/);
    }
  });

  it("returns handle + preview when store accepts the payload", () => {
    const store = new ContextMemoryStore({
      ...DEFAULT_CONTEXT_MEMORY,
      enabled: true,
      previewHeadChars: 10,
      previewTailChars: 10,
    });
    const mw = makeOverflowMiddleware(50, { store });
    const payload = "HEAD_" + "M".repeat(500) + "_TAIL";
    const result = mw(ctx(), payload);
    assert.equal(result.block, true);
    if (result.block) {
      assert.match(result.replacement, /overflow_1/);
      assert.match(result.replacement, /Size: \d+ bytes/);
      assert.match(result.replacement, /Preview:/);
      assert.match(result.replacement, /HEAD_/);
      assert.match(result.replacement, /_TAIL/);
    }
    assert.equal(store.size(), 1);
  });

  it("falls back to legacy message when store is full", () => {
    const store = new ContextMemoryStore({
      ...DEFAULT_CONTEXT_MEMORY,
      enabled: true,
      maxEntries: 1,
    });
    const mw = makeOverflowMiddleware(50, { store });
    // First overflow goes into the store.
    const first = mw(ctx(), "x".repeat(200));
    assert.equal(first.block, true);
    if (first.block) assert.match(first.replacement, /overflow_1/);
    // Second overflow is rejected by maxEntries → legacy fallback.
    const second = mw(ctx(), "y".repeat(200));
    assert.equal(second.block, true);
    if (second.block) {
      assert.match(second.replacement, /refine your codebase-retrieval query/);
      assert.doesNotMatch(second.replacement, /overflow_/);
    }
  });

  it("does not store non-auggie tool results", () => {
    const store = new ContextMemoryStore({
      ...DEFAULT_CONTEXT_MEMORY,
      enabled: true,
    });
    const mw = makeOverflowMiddleware(50, { store });
    const result = mw(
      { serverName: "other-mcp", toolName: AUGGIE_TOOL_NAME, args: {} },
      "x".repeat(200)
    );
    assert.deepEqual(result, { block: false });
    assert.equal(store.size(), 0);
  });

  it("does not store payloads under the ceiling", () => {
    const store = new ContextMemoryStore({
      ...DEFAULT_CONTEXT_MEMORY,
      enabled: true,
    });
    const mw = makeOverflowMiddleware(1_000, { store });
    const result = mw(ctx(), "x".repeat(500));
    assert.deepEqual(result, { block: false });
    assert.equal(store.size(), 0);
  });
});

function makeSkill(): ParsedSkill {
  return {
    name: "demo",
    filePath: "/tmp/skill",
    rawModel: undefined,
    instructions: "Do it.",
  };
}
function makeBrief(): SkillBrief {
  return { userGoal: "g", constraints: [], knownContext: "", userClarifications: [] };
}

function makeHost(): { host: PiHost; calls: SubAgentRunOptions[] } {
  const calls: SubAgentRunOptions[] = [];
  const host: PiHost = {
    postSystemMessage: () => {},
    postAssistantMessage: () => {},
    setInputLocked: () => {},
    getRecentMessages: () => [],
    callLLM: async () => ({ text: "" }),
    runSubAgent: async (opts) => {
      calls.push(opts);
      return { finalText: "ok", stoppedReason: "completed" };
    },
    onBeforeMessage: () => () => {},
    onUserInput: () => () => {},
    resolveWorkspacePath: (rel) => rel,
    resolveHomePath: (rel) => rel,
  };
  return { host, calls };
}

describe("executeSkill — context memory lifecycle", () => {
  it("creates a store when contextMemory is enabled and disposes after run", async () => {
    const { host, calls } = makeHost();
    const settings: RouterSettings = {
      ...DEFAULT_SETTINGS,
      contextMemory: {
        ...DEFAULT_CONTEXT_MEMORY,
        enabled: true,
        previewHeadChars: 5,
        previewTailChars: 5,
      },
    };
    await executeSkill(host, settings, {
      skill: makeSkill(),
      brief: makeBrief(),
      resolvedModel: "openrouter/x/y",
      overflowCeilingBytes: 50,
    });
    const mw = calls[0]!.toolResultMiddleware!;
    const result = mw(ctx(), "HEAD_" + "M".repeat(200) + "_TAIL");
    assert.equal(result.block, true);
    if (result.block) {
      // Owned store is disposed by the time the middleware runs after the
      // sub-agent resolved — but our mock host already returned, so the
      // dispose happened. Calling the middleware now should still block,
      // but the store is empty → fall back to legacy message.
      assert.match(result.replacement, /refine your codebase-retrieval query/);
    }
  });

  it("uses caller-provided store and does not dispose it", async () => {
    const { host, calls } = makeHost();
    const store = new ContextMemoryStore({
      ...DEFAULT_CONTEXT_MEMORY,
      enabled: true,
      previewHeadChars: 5,
      previewTailChars: 5,
    });
    const settings: RouterSettings = {
      ...DEFAULT_SETTINGS,
      contextMemory: {
        ...DEFAULT_CONTEXT_MEMORY,
        enabled: true,
      },
    };
    await executeSkill(host, settings, {
      skill: makeSkill(),
      brief: makeBrief(),
      resolvedModel: "openrouter/x/y",
      overflowCeilingBytes: 50,
      contextMemory: store,
    });
    // Store survives the run. Exercising the middleware after `runSubAgent`
    // returned should still be able to write.
    const mw = calls[0]!.toolResultMiddleware!;
    const result = mw(ctx(), "HEAD_" + "M".repeat(200) + "_TAIL");
    assert.equal(result.block, true);
    if (result.block) assert.match(result.replacement, /overflow_1/);
    assert.equal(store.size(), 1);
    store.dispose();
  });

  it("does not create a store when contextMemory.enabled is false", async () => {
    const { host, calls } = makeHost();
    await executeSkill(host, DEFAULT_SETTINGS, {
      skill: makeSkill(),
      brief: makeBrief(),
      resolvedModel: "openrouter/x/y",
      overflowCeilingBytes: 50,
    });
    const mw = calls[0]!.toolResultMiddleware!;
    const result = mw(ctx(), "x".repeat(200));
    assert.equal(result.block, true);
    if (result.block) {
      assert.match(result.replacement, /refine your codebase-retrieval query/);
      assert.doesNotMatch(result.replacement, /overflow_/);
    }
  });
});
