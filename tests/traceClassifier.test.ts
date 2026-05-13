import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTrace, detectRegression, extractSignalPrefix } from "../src/traceClassifier.ts";
import type { ExecutionTrace } from "../src/executionTrace.ts";
import type { TraceVerdict } from "../src/traceClassifier.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    skillName: "test-skill",
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
    finalText: "Done successfully.",
    stoppedReason: "completed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyTrace
// ---------------------------------------------------------------------------

describe("classifyTrace", () => {
  it("classifies clean success as 'success'", () => {
    const trace = makeTrace();
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "success");
    assert.equal(verdict.signals.length, 0);
    assert.ok(verdict.confidence >= 0.9);
  });

  it("detects timeout", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.some(s => s.includes("timeout")));
  });

  it("detects inactivity", () => {
    const trace = makeTrace({ stoppedReason: "inactivity", finalText: "partial" });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.some(s => s.includes("inactivity")));
  });

  it("detects abort", () => {
    const trace = makeTrace({ stoppedReason: "aborted", finalText: "" });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.some(s => s.includes("aborted")));
  });

  it("detects empty output", () => {
    const trace = makeTrace({ finalText: "" });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.some(s => s.includes("empty output")));
  });

  it("detects error markers in output (case-insensitive, first 200 chars)", () => {
    const trace = makeTrace({ finalText: "ERROR: something went wrong in processing." });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.some(s => s.includes("error markers")));
  });

  it("does not flag error markers beyond the first 200 chars", () => {
    const padding = "x".repeat(250);
    const trace = makeTrace({ finalText: padding + " an error occurred" });
    const verdict = classifyTrace(trace);
    // The error marker is beyond 200 chars, so it shouldn't be detected.
    assert.equal(verdict.outcome, "success");
  });

  it("detects high tool-call count (> 20)", () => {
    const toolCalls = Array.from({ length: 25 }, (_, i) => ({
      index: i,
      serverName: "auggie",
      toolName: "codebase-retrieval",
      args: {},
      resultPreview: "result",
      blocked: false,
      timestamp: Date.now() + i * 1000,
    }));
    const trace = makeTrace({ toolCalls });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.some(s => s.includes("high tool-call count")));
  });

  it("does not flag tool-call count at exactly 20", () => {
    const toolCalls = Array.from({ length: 20 }, (_, i) => ({
      index: i,
      serverName: "auggie",
      toolName: "codebase-retrieval",
      args: {},
      resultPreview: "result",
      blocked: false,
      timestamp: Date.now() + i * 1000,
    }));
    const trace = makeTrace({ toolCalls });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "success");
  });

  it("detects low route confidence (< 0.5)", () => {
    const trace = makeTrace({
      route: {
        tier: "balanced",
        complexity: "medium",
        risk: "unknown",
        confidence: 0.3,
        reason: "ambiguous task",
      },
    });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.some(s => s.includes("low route confidence")));
  });

  it("does not flag confidence at exactly 0.5", () => {
    const trace = makeTrace({
      route: {
        tier: "balanced",
        complexity: "medium",
        risk: "unknown",
        confidence: 0.5,
        reason: "borderline",
      },
    });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "success");
  });

  it("collects multiple signals simultaneously", () => {
    const trace = makeTrace({
      stoppedReason: "timeout",
      finalText: "failed: error processing request",
      toolCalls: Array.from({ length: 25 }, (_, i) => ({
        index: i,
        serverName: "auggie",
        toolName: "tool",
        args: {},
        resultPreview: "r",
        blocked: false,
        timestamp: Date.now() + i * 1000,
      })),
      route: {
        tier: "balanced",
        complexity: "high",
        risk: "unknown",
        confidence: 0.2,
        reason: "uncertain",
      },
    });
    const verdict = classifyTrace(trace);
    assert.equal(verdict.outcome, "likely-failure");
    assert.ok(verdict.signals.length >= 4);
    assert.ok(verdict.confidence >= 0.9); // 3+ signals → high confidence
  });

  it("returns 'unknown' for completed with empty output (no other signals)", () => {
    // This is a defensive edge case — empty output IS a signal, so this
    // should actually be likely-failure. Let's test what happens with
    // a non-completed, non-empty trace with no negative signals.
    const trace = makeTrace({
      stoppedReason: "completed",
      finalText: "   ", // whitespace-only = empty after trim
    });
    const verdict = classifyTrace(trace);
    // Empty output detection should trigger
    assert.equal(verdict.outcome, "likely-failure");
  });
});

// ---------------------------------------------------------------------------
// detectRegression
// ---------------------------------------------------------------------------

describe("detectRegression", () => {
  it("does not upgrade success verdicts", () => {
    const verdict: TraceVerdict = { outcome: "success", signals: [], confidence: 0.9 };
    const trace = makeTrace();
    const result = detectRegression(verdict, trace, []);
    assert.equal(result.outcome, "success");
  });

  it("does not upgrade when no historical success exists", () => {
    const verdict: TraceVerdict = {
      outcome: "likely-failure",
      signals: ["timeout"],
      confidence: 0.6,
    };
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    // 4 failures, no success
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
    ];
    const result = detectRegression(verdict, trace, recent);
    assert.equal(result.outcome, "likely-failure");
    assert.ok(!result.signals.some(s => s.includes("regression")));
  });

  it("upgrades to likely-regression after 3 consecutive failures with prior success", () => {
    const verdict: TraceVerdict = {
      outcome: "likely-failure",
      signals: ["timeout"],
      confidence: 0.6,
    };
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }), // failure 3 (most recent)
      makeTrace({ stoppedReason: "timeout", finalText: "" }), // failure 2
      makeTrace({ stoppedReason: "completed", finalText: "ok" }), // success (proof of prior success)
    ];
    const result = detectRegression(verdict, trace, recent);
    assert.equal(result.outcome, "likely-regression");
    assert.ok(result.signals.some(s => s.includes("regression")));
    assert.ok(result.confidence > 0.6); // Confidence boosted
  });

  it("does not upgrade when failures are not consecutive (success in between)", () => {
    const verdict: TraceVerdict = {
      outcome: "likely-failure",
      signals: ["timeout"],
      confidence: 0.6,
    };
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "completed", finalText: "ok" }), // success breaks the streak
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    const result = detectRegression(verdict, trace, recent);
    assert.equal(result.outcome, "likely-failure");
  });

  it("respects regressionWindowSize", () => {
    const verdict: TraceVerdict = {
      outcome: "likely-failure",
      signals: ["timeout"],
      confidence: 0.6,
    };
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    // 10 recent traces: success is at position 6, outside window of 5
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      // This one is outside the window of 5:
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    const result = detectRegression(verdict, trace, recent, 5);
    // With window=5, only the first 5 are examined — no success in window
    assert.equal(result.outcome, "likely-failure");
  });
});

// ---------------------------------------------------------------------------
// extractSignalPrefix
// ---------------------------------------------------------------------------

describe("extractSignalPrefix", () => {
  it("extracts prefix before em-dash separator", () => {
    assert.equal(extractSignalPrefix("timeout — sub-agent hit wall clock limit"), "timeout");
  });

  it("extracts prefix before parenthetical detail", () => {
    assert.equal(extractSignalPrefix("error markers in output (error, failed)"), "error markers in output");
  });

  it("extracts prefix before parenthetical with numbers", () => {
    assert.equal(extractSignalPrefix("high tool-call count (28 calls, threshold 20)"), "high tool-call count");
  });

  it("returns full string when no separator present", () => {
    assert.equal(extractSignalPrefix("timeout"), "timeout");
  });

  it("extracts prefix from low confidence signal", () => {
    assert.equal(extractSignalPrefix("low route confidence (0.30, threshold 0.5)"), "low route confidence");
  });
});
