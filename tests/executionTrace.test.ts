import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionTraceStore,
  makeTraceMiddleware,
} from "../src/executionTrace.ts";
import type { SkillBrief, ExecutionRoute } from "../src/types.ts";

const MOCK_BRIEF: SkillBrief = {
  userGoal: "Test the trace store",
  constraints: [],
  knownContext: "",
  userClarifications: [],
};

const MOCK_ROUTE: ExecutionRoute = {
  tier: "balanced",
  complexity: "low",
  risk: "read_only",
  confidence: 0.9,
  reason: "Test run",
};

const DEFAULT_SETTINGS = {
  enabled: true,
  maxResultPreviewChars: 2_000,
  traceDirectory: ".pi/traces",
};

function makeStore(): ExecutionTraceStore {
  return new ExecutionTraceStore(DEFAULT_SETTINGS, {
    skillName: "test-skill",
    model: "test-model",
    brief: MOCK_BRIEF,
    route: MOCK_ROUTE,
  });
}

describe("ExecutionTraceStore", () => {
  it("records tool calls via middleware", () => {
    const store = makeStore();
    const mw = makeTraceMiddleware(store);

    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: { q: "test" } }, "result text");

    assert.equal(store.toolCallCount, 1);
  });

  it("records multiple tool calls with correct indices", () => {
    const store = makeStore();
    const mw = makeTraceMiddleware(store);

    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: {} }, "first");
    mw({ serverName: "other", toolName: "read", args: {} }, "second");
    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: {} }, "third");

    assert.equal(store.toolCallCount, 3);

    const trace = store.finalize("done", "completed");
    assert.equal(trace.toolCalls[0].index, 0);
    assert.equal(trace.toolCalls[1].index, 1);
    assert.equal(trace.toolCalls[2].index, 2);
    assert.equal(trace.toolCalls[0].serverName, "auggie");
    assert.equal(trace.toolCalls[1].serverName, "other");
    assert.equal(trace.toolCalls[2].toolName, "codebase-retrieval");
  });

  it("truncates long tool results in the preview", () => {
    const settings = { ...DEFAULT_SETTINGS, maxResultPreviewChars: 50 };
    const store = new ExecutionTraceStore(settings, {
      skillName: "test",
      model: "m",
      brief: MOCK_BRIEF,
      route: MOCK_ROUTE,
    });
    const mw = makeTraceMiddleware(store);

    const longResult = "x".repeat(200);
    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: {} }, longResult);

    const trace = store.finalize("done", "completed");
    assert.ok(trace.toolCalls[0].resultPreview.length < 200);
    assert.ok(trace.toolCalls[0].resultPreview.includes("[...truncated"));
  });

  it("finalizes with correct metadata", () => {
    const store = makeStore();
    const mw = makeTraceMiddleware(store);
    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: {} }, "data");

    const trace = store.finalize("final answer text", "completed");
    assert.equal(trace.skillName, "test-skill");
    assert.equal(trace.model, "test-model");
    assert.deepEqual(trace.brief, MOCK_BRIEF);
    assert.deepEqual(trace.route, MOCK_ROUTE);
    assert.equal(trace.finalText, "final answer text");
    assert.equal(trace.stoppedReason, "completed");
    assert.equal(trace.toolCalls.length, 1);
  });

  it("throws on double finalize", () => {
    const store = makeStore();
    store.finalize("first", "completed");
    assert.throws(() => store.finalize("second", "completed"), /already finalized/);
  });

  it("stops recording after dispose", () => {
    const store = makeStore();
    const mw = makeTraceMiddleware(store);
    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: {} }, "before");
    assert.equal(store.toolCallCount, 1);

    store.dispose();
    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: {} }, "after");
    assert.equal(store.toolCallCount, 1);
  });

  it("persists and loads traces round-trip", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { randomUUID } = await import("node:crypto");

    const dir = join(tmpdir(), `pi-trace-test-${randomUUID()}`);
    const settings = { ...DEFAULT_SETTINGS, traceDirectory: "traces" };
    const store = new ExecutionTraceStore(settings, {
      skillName: "persist-test",
      model: "m",
      brief: MOCK_BRIEF,
      route: MOCK_ROUTE,
    });
    const mw = makeTraceMiddleware(store);
    mw({ serverName: "auggie", toolName: "codebase-retrieval", args: { q: "test" } }, "result");

    const trace = store.finalize("output", "completed");
    const filepath = store.persist(trace, dir);

    assert.ok(filepath.endsWith(".json"));

    // Load it back
    const loaded = ExecutionTraceStore.loadTraces(join(dir, "traces"), "persist-test");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].skillName, "persist-test");
    assert.equal(loaded[0].finalText, "output");
    assert.equal(loaded[0].toolCalls.length, 1);
    assert.equal(loaded[0].toolCalls[0].toolName, "codebase-retrieval");

    // Cleanup
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent trace directory", () => {
    const loaded = ExecutionTraceStore.loadTraces("/nonexistent/path", "anything");
    assert.deepEqual(loaded, []);
  });
});
