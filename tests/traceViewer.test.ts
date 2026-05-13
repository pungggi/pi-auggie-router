import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTraceView, DEFAULT_TRACE_VIEW_CONFIG } from "../src/traceViewer.ts";
import type { TraceViewConfig } from "../src/traceViewer.ts";
import type { ExecutionTrace, ToolCallEntry } from "../src/executionTrace.ts";
import type { TraceVerdict } from "../src/traceClassifier.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIMESTAMP = 1746960000000; // 2025-05-11 00:00:00 UTC

function makeToolCall(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    index: 0,
    serverName: "auggie",
    toolName: "codebase-retrieval",
    args: { query: "test query" },
    resultPreview: "result text with some content",
    blocked: false,
    timestamp: BASE_TIMESTAMP,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    skillName: "refactor",
    timestamp: BASE_TIMESTAMP,
    model: "anthropic/claude-3-5-haiku",
    brief: {
      userGoal: "Refactor the auth module",
      constraints: [],
      knownContext: "",
      userClarifications: "",
    },
    route: {
      tier: "balanced",
      complexity: "medium",
      risk: "small_edit",
      confidence: 0.82,
      reason: "Medium complexity refactoring",
    },
    toolCalls: [
      makeToolCall({ index: 0, timestamp: BASE_TIMESTAMP }),
      makeToolCall({
        index: 1,
        toolName: "apply-diff",
        args: { path: "src/auth.ts" },
        resultPreview: "diff applied successfully",
        timestamp: BASE_TIMESTAMP + 5000,
      }),
      makeToolCall({
        index: 2,
        toolName: "codebase-retrieval",
        args: { query: "verify the change" },
        resultPreview: "verification result",
        timestamp: BASE_TIMESTAMP + 12000,
      }),
    ],
    finalText: "Refactoring complete. The auth module now uses dependency injection.",
    stoppedReason: "completed",
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<TraceVerdict> = {}): TraceVerdict {
  return {
    outcome: "success",
    signals: [],
    confidence: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderTraceView
// ---------------------------------------------------------------------------

describe("renderTraceView", () => {
  it("renders header with filename and model", () => {
    const trace = makeTrace();
    const view = renderTraceView("refactor_1746960000000.json", trace);
    assert.ok(view.includes("🔍 Trace: refactor_1746960000000.json"));
    assert.ok(view.includes("Model: anthropic/claude-3-5-haiku"));
  });

  it("renders route metadata", () => {
    const trace = makeTrace();
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("Route: balanced, medium complexity"));
    assert.ok(view.includes("Confidence: 82%"));
    assert.ok(view.includes("Risk: small_edit"));
  });

  it("renders success outcome without signals", () => {
    const trace = makeTrace();
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("✅ success"));
    assert.ok(view.includes("Tool calls: 3"));
  });

  it("renders failure outcome with signals", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const verdict = makeVerdict({
      outcome: "likely-failure",
      signals: ["timeout — sub-agent hit wall clock limit"],
      confidence: 0.6,
    });
    const view = renderTraceView("test.json", trace, verdict);
    assert.ok(view.includes("⚠️ likely-failure"));
    assert.ok(view.includes("timeout"));
  });

  it("renders tool-call timeline with offsets", () => {
    const trace = makeTrace();
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("Timeline:"));
    assert.ok(view.includes("[0s]"));
    assert.ok(view.includes("[5s]"));
    assert.ok(view.includes("[12s]"));
    assert.ok(view.includes("auggie / codebase-retrieval"));
    assert.ok(view.includes("auggie / apply-diff"));
  });

  it("renders result sizes", () => {
    const trace = makeTrace();
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("chars"));
  });

  it("renders args preview for common arg shapes", () => {
    const trace = makeTrace();
    const view = renderTraceView("test.json", trace);
    // First call has { query: "test query" }
    assert.ok(view.includes("query=\"test query\""));
    // Second call has { path: "src/auth.ts" }
    assert.ok(view.includes("path=\"src/auth.ts\""));
  });

  it("renders stopped reason annotation for timeout", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("⏰ timeout"));
  });

  it("renders stopped reason annotation for inactivity", () => {
    const trace = makeTrace({ stoppedReason: "inactivity", finalText: "" });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("💤 inactivity"));
  });

  it("renders stopped reason annotation for abort", () => {
    const trace = makeTrace({ stoppedReason: "aborted", finalText: "" });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("🛑 aborted"));
  });

  it("renders final text when present", () => {
    const trace = makeTrace();
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("Final text:"));
    assert.ok(view.includes("Refactoring complete"));
  });

  it("renders empty final text", () => {
    const trace = makeTrace({ finalText: "" });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("Final text: (empty)"));
  });

  it("truncates long final text", () => {
    const longText = "x".repeat(500);
    const trace = makeTrace({ finalText: longText });
    const view = renderTraceView("test.json", trace, undefined, {
      ...DEFAULT_TRACE_VIEW_CONFIG,
      maxFinalTextChars: 100,
    });
    assert.ok(view.includes("500 chars total"));
    assert.ok(!view.includes("x".repeat(500)));
  });

  it("renders (no tool calls) when timeline is empty", () => {
    const trace = makeTrace({ toolCalls: [], finalText: "done" });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("(no tool calls)"));
  });

  it("auto-classifies when no verdict provided", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const view = renderTraceView("test.json", trace);
    // classifyTrace should detect timeout
    assert.ok(view.includes("timeout"));
  });

  it("renders blocked tool calls", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({ blocked: true }),
      ],
    });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("⛔ blocked"));
  });

  it("renders truncated result previews with total chars", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({
          resultPreview: "some text\n[...truncated, 5000 total chars]",
        }),
      ],
    });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("5,000 chars  (preview)"));
  });
});

// ---------------------------------------------------------------------------
// Timeline truncation
// ---------------------------------------------------------------------------

describe("renderTraceView — timeline truncation", () => {
  it("shows all calls when within maxTimelineEntries", () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      makeToolCall({ index: i, timestamp: BASE_TIMESTAMP + i * 1000 })
    );
    const trace = makeTrace({ toolCalls: calls });
    const view = renderTraceView("test.json", trace, undefined, {
      ...DEFAULT_TRACE_VIEW_CONFIG,
      maxTimelineEntries: 10,
    });
    assert.ok(!view.includes("calls omitted"));
  });

  it("truncates with ellipsis when exceeding maxTimelineEntries", () => {
    const calls = Array.from({ length: 40 }, (_, i) =>
      makeToolCall({ index: i, timestamp: BASE_TIMESTAMP + i * 1000 })
    );
    const trace = makeTrace({ toolCalls: calls });
    const view = renderTraceView("test.json", trace, undefined, {
      ...DEFAULT_TRACE_VIEW_CONFIG,
      maxTimelineEntries: 10,
    });
    assert.ok(view.includes("calls omitted"));
  });

  it("shows first and last calls when truncated", () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      makeToolCall({ index: i, timestamp: BASE_TIMESTAMP + i * 1000 })
    );
    const trace = makeTrace({ toolCalls: calls });
    const view = renderTraceView("test.json", trace, undefined, {
      ...DEFAULT_TRACE_VIEW_CONFIG,
      maxTimelineEntries: 6,
    });
    // Should show [0s] (first) and later offsets (last)
    assert.ok(view.includes("[0s]"));
    assert.ok(view.includes("calls omitted"));
  });
});

// ---------------------------------------------------------------------------
// Args preview
// ---------------------------------------------------------------------------

describe("renderTraceView — args preview", () => {
  it("shows empty args preview for empty args", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({ args: {} }),
      ],
    });
    const view = renderTraceView("test.json", trace);
    // No args preview shown — just server/tool and result
    assert.ok(view.includes("auggie / codebase-retrieval"));
  });

  it("truncates long arg values", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({ args: { query: "a".repeat(200) } }),
      ],
    });
    const view = renderTraceView("test.json", trace, undefined, {
      ...DEFAULT_TRACE_VIEW_CONFIG,
      maxArgsPreviewChars: 40,
    });
    assert.ok(view.includes("..."));
  });

  it("prefers 'query' over 'q' in args", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({ args: { query: "my query", q: "my q" } }),
      ],
    });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("query=\"my query\""));
  });

  it("shows no preview for array args", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({ args: [1, 2, 3] as unknown as Record<string, unknown> }),
      ],
    });
    const view = renderTraceView("test.json", trace);
    // Should not crash, and should not show a key="value" preview
    const line = view.split("\n").find(l => l.includes("[0s]"));
    assert.ok(line);
    assert.ok(!line!.includes("0=\""));
  });
});

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

describe("renderTraceView — duration", () => {
  it("shows <1s for no tool calls", () => {
    const trace = makeTrace({ toolCalls: [] });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("Duration: <1s"));
  });

  it("shows seconds for sub-minute durations", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({ timestamp: BASE_TIMESTAMP }),
        makeToolCall({ index: 1, timestamp: BASE_TIMESTAMP + 45000 }),
      ],
    });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("Duration: 45s"));
  });

  it("shows minutes+seconds for longer durations", () => {
    const trace = makeTrace({
      toolCalls: [
        makeToolCall({ timestamp: BASE_TIMESTAMP }),
        makeToolCall({ index: 1, timestamp: BASE_TIMESTAMP + 185000 }),
      ],
    });
    const view = renderTraceView("test.json", trace);
    assert.ok(view.includes("Duration: 3m5s"));
  });
});
