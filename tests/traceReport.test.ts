import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderTraceReport,
  renderMiniReport,
} from "../src/traceReport.ts";
import type { TraceReportConfig, TraceReportInput } from "../src/traceReport.ts";
import type { TraceVerdict } from "../src/traceClassifier.ts";
import type { ExecutionTrace } from "../src/executionTrace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    skillName: "refactor",
    timestamp: Date.now(),
    model: "anthropic/claude-3-5-sonnet",
    brief: {
      userGoal: "test goal",
      constraints: [],
      knownContext: "",
      userClarifications: [],
    },
    route: {
      tier: "balanced",
      complexity: "medium",
      risk: "small_edit",
      confidence: 0.8,
      reason: "test",
    },
    toolCalls: [],
    finalText: "Done.",
    stoppedReason: "completed",
    ...overrides,
  };
}

function makeVerdict(outcome: TraceVerdict["outcome"] = "success"): TraceVerdict {
  return { outcome, signals: [], confidence: 0.9 };
}

const DEFAULT_CONFIG: TraceReportConfig = {
  maxTraces: 10,
  maxInlineTraces: 5,
  trendWindowSize: 5,
};

// ---------------------------------------------------------------------------
// renderTraceReport
// ---------------------------------------------------------------------------

describe("renderTraceReport", () => {
  it("returns 'no traces' message for empty input", () => {
    const report = renderTraceReport(
      "refactor",
      { verdicts: [], traces: [] },
      DEFAULT_CONFIG
    );
    assert.ok(report.includes("No traces found"));
    assert.ok(report.includes("refactor"));
  });

  it("renders header with trace count", () => {
    const traces = [makeTrace(), makeTrace()];
    const verdicts = [makeVerdict(), makeVerdict()];
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      DEFAULT_CONFIG
    );
    assert.ok(report.includes("Trace Report"));
    assert.ok(report.includes("last 2 runs"));
  });

  it("renders outcome distribution with bar chart", () => {
    const traces = Array.from({ length: 10 }, (_, i) =>
      makeTrace({ timestamp: Date.now() - i * 1000 })
    );
    const verdicts: TraceVerdict[] = [
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("likely-failure"),
      makeVerdict("likely-failure"),
      makeVerdict("likely-failure"),
      makeVerdict("unknown"),
    ];
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      DEFAULT_CONFIG
    );
    assert.ok(report.includes("Success"));
    assert.ok(report.includes("6/10"));
    assert.ok(report.includes("60%"));
    assert.ok(report.includes("Likely fail"));
    assert.ok(report.includes("3/10"));
    assert.ok(report.includes("Unknown"));
  });

  it("renders common failure signals", () => {
    const traces = [makeTrace(), makeTrace()];
    const verdicts: TraceVerdict[] = [
      { outcome: "likely-failure", signals: ["timeout — hit wall clock limit"], confidence: 0.6 },
      { outcome: "likely-failure", signals: ["timeout — hit wall clock limit", "empty output — no text"], confidence: 0.75 },
    ];
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      DEFAULT_CONFIG
    );
    assert.ok(report.includes("Common failure signals"));
    assert.ok(report.includes("timeout"));
    assert.ok(report.includes("2x"));
  });

  it("renders trend when enough data exists", () => {
    // 10 traces: first 5 success rate 80%, last 5 success rate 40%
    const traces = Array.from({ length: 10 }, (_, i) =>
      makeTrace({ timestamp: Date.now() - i * 1000 })
    );
    const verdicts: TraceVerdict[] = [
      makeVerdict("success"),
      makeVerdict("likely-failure"),
      makeVerdict("success"),
      makeVerdict("likely-failure"),
      makeVerdict("success"),
      // older 5: 4 success, 1 failure = 80%
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("success"),
      makeVerdict("likely-failure"),
    ];
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      { maxTraces: 10, maxInlineTraces: 5, trendWindowSize: 5 }
    );
    assert.ok(report.includes("Trend"));
    assert.ok(report.includes("80% → 60%"));
  });

  it("renders recent traces list with verdicts", () => {
    const traces = [
      makeTrace({ timestamp: 1000, stoppedReason: "completed", toolCalls: Array.from({ length: 5 }, (_, i) => ({ index: i, serverName: "auggie", toolName: "tool", args: {}, resultPreview: "r", blocked: false, timestamp: 1000 + i * 100 })) }),
      makeTrace({ timestamp: 2000, stoppedReason: "timeout", finalText: "" }),
    ];
    const verdicts: TraceVerdict[] = [
      makeVerdict("success"),
      makeVerdict("likely-failure"),
    ];
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      DEFAULT_CONFIG
    );
    assert.ok(report.includes("Recent traces"));
    assert.ok(report.includes("✅"));
    assert.ok(report.includes("⚠️"));
    assert.ok(report.includes("5 calls"));
    assert.ok(report.includes("timeout"));
  });

  it("respects maxTraces config", () => {
    const traces = Array.from({ length: 20 }, (_, i) =>
      makeTrace({ timestamp: Date.now() - i * 1000 })
    );
    const verdicts = traces.map(() => makeVerdict());
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      { maxTraces: 5, maxInlineTraces: 5, trendWindowSize: 5 }
    );
    assert.ok(report.includes("last 5 runs"));
    // Should have exactly 5 trace lines
    const traceLines = report.split("\n").filter(l => l.includes("refactor_"));
    assert.equal(traceLines.length, 5);
  });

  it("skips outcome categories with zero count", () => {
    const traces = [makeTrace()];
    const verdicts = [makeVerdict("success")];
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      DEFAULT_CONFIG
    );
    assert.ok(report.includes("Success"));
    assert.ok(!report.includes("Likely fail"));
    assert.ok(!report.includes("Unknown"));
  });

  it("handles regression verdicts", () => {
    const traces = [makeTrace()];
    const verdicts: TraceVerdict[] = [
      { outcome: "likely-regression", signals: ["regression — 3 consecutive failures"], confidence: 0.95 },
    ];
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      DEFAULT_CONFIG
    );
    assert.ok(report.includes("Regression"));
    assert.ok(report.includes("📉"));
  });
});

// ---------------------------------------------------------------------------
// renderMiniReport
// ---------------------------------------------------------------------------

describe("renderMiniReport", () => {
  it("returns 'no traces' message for empty input", () => {
    const report = renderMiniReport("refactor", { verdicts: [], traces: [] });
    assert.ok(report.includes("No traces found"));
  });

  it("renders compact 3-trace summary", () => {
    const traces = [
      makeTrace({ stoppedReason: "completed", toolCalls: Array.from({ length: 10 }, (_, i) => ({ index: i, serverName: "auggie", toolName: "tool", args: {}, resultPreview: "r", blocked: false, timestamp: 1000 + i * 100 })) }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed" }),
    ];
    const verdicts: TraceVerdict[] = [
      makeVerdict("success"),
      makeVerdict("likely-failure"),
      makeVerdict("success"),
    ];
    const report = renderMiniReport("refactor", { verdicts, traces });
    assert.ok(report.includes("Mini report"));
    assert.ok(report.includes("last 3 runs"));
    assert.ok(report.includes("✅"));
    assert.ok(report.includes("⚠️"));
  });

  it("renders fewer traces when less than 3 available", () => {
    const traces = [makeTrace()];
    const verdicts = [makeVerdict("success")];
    const report = renderMiniReport("refactor", { verdicts, traces });
    assert.ok(report.includes("last 1 run"));
  });
});

// ---------------------------------------------------------------------------
// maxInlineTraces truncation
// ---------------------------------------------------------------------------

describe("renderTraceReport — maxInlineTraces truncation", () => {
  it("truncates recent traces list to maxInlineTraces", () => {
    const traces = Array.from({ length: 10 }, (_, i) =>
      makeTrace({ timestamp: Date.now() - i * 1000 })
    );
    const verdicts = traces.map(() => makeVerdict("success"));
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      { maxTraces: 10, maxInlineTraces: 3, trendWindowSize: 5 }
    );
    // Distribution shows all 10, but trace list is truncated.
    assert.ok(report.includes("last 10 runs"));
    assert.ok(report.includes("showing 3 of 10"));
    const traceLines = report.split("\n").filter(l => l.includes("refactor_"));
    assert.equal(traceLines.length, 3);
  });

  it("does not show truncation notice when traces fit within maxInlineTraces", () => {
    const traces = Array.from({ length: 3 }, (_, i) =>
      makeTrace({ timestamp: Date.now() - i * 1000 })
    );
    const verdicts = traces.map(() => makeVerdict("success"));
    const report = renderTraceReport(
      "refactor",
      { verdicts, traces },
      { maxTraces: 10, maxInlineTraces: 5, trendWindowSize: 5 }
    );
    assert.ok(!report.includes("showing"));
    assert.ok(report.includes("Recent traces:"));
    const traceLines = report.split("\n").filter(l => l.includes("refactor_"));
    assert.equal(traceLines.length, 3);
  });
});
