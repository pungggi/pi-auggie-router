import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkDegradationAlert,
  createAlertCooldownTracker,
  resetAlertCooldowns,
} from "../src/degradationAlert.ts";
import type { DegradationAlertConfig } from "../src/degradationAlert.ts";
import type { TraceVerdict } from "../src/traceClassifier.ts";
import type { ExecutionTrace } from "../src/executionTrace.ts";

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

function successVerdict(): TraceVerdict {
  return { outcome: "success", signals: [], confidence: 0.9 };
}

function failureVerdict(signals: string[] = ["timeout"]): TraceVerdict {
  return { outcome: "likely-failure", signals, confidence: 0.6 };
}

const DEFAULT_CONFIG: DegradationAlertConfig = {
  enabled: true,
  consecutiveFailures: 3,
  cooldownHours: 24,
};

// ---------------------------------------------------------------------------
// checkDegradationAlert
// ---------------------------------------------------------------------------

describe("checkDegradationAlert", () => {
  beforeEach(() => {
    resetAlertCooldowns();
  });

  it("does not fire for a success verdict", () => {
    const result = checkDegradationAlert(
      successVerdict(),
      makeTrace(),
      [],
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, false);
  });

  it("does not fire when alerts are disabled", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const result = checkDegradationAlert(
      failureVerdict(),
      trace,
      [],
      undefined,
      { ...DEFAULT_CONFIG, enabled: false }
    );
    assert.equal(result.fired, false);
  });

  it("does not fire when consecutive failures < threshold", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    // Only 1 prior failure + current = 2, threshold = 3
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    const result = checkDegradationAlert(
      failureVerdict(),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, false);
  });

  it("does not fire when skill has no historical success", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    // All failures, no success
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
    ];
    const result = checkDegradationAlert(
      failureVerdict(),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, false);
  });

  it("fires when threshold met and skill has historical success", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    // 2 recent failures + 1 success
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    const result = checkDegradationAlert(
      failureVerdict(["timeout — sub-agent hit wall clock limit"]),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, true);
    assert.ok(result.message);
    assert.ok(result.message!.includes("Degradation detected"));
    assert.ok(result.message!.includes("test-skill"));
    assert.ok(result.message!.includes("3 consecutive"));
    assert.ok(result.message!.includes("timeout"));
    assert.ok(result.message!.includes("Last successful run"));
  });

  it("uses pre-classified verdicts when provided", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    const recentVerdicts: TraceVerdict[] = [
      failureVerdict(["high tool-call count (25 calls, threshold 20)"]),
      failureVerdict(["timeout — sub-agent hit wall clock limit"]),
      successVerdict(),
    ];
    const result = checkDegradationAlert(
      failureVerdict(["timeout — sub-agent hit wall clock limit"]),
      trace,
      recent,
      recentVerdicts,
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, true);
    assert.ok(result.message!.includes("timeout"));
    assert.ok(result.message!.includes("high tool-call count"));
  });

  it("aggregates signal counts across failures", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    // Provide pre-classified verdicts with signals for historical traces.
    const recentVerdicts: TraceVerdict[] = [
      { outcome: "likely-failure", signals: ["timeout — sub-agent hit wall clock limit"], confidence: 0.6 },
      { outcome: "likely-failure", signals: ["timeout — sub-agent hit wall clock limit"], confidence: 0.6 },
      { outcome: "success", signals: [], confidence: 0.9 },
    ];
    const result = checkDegradationAlert(
      failureVerdict(["timeout — sub-agent hit wall clock limit"]),
      trace,
      recent,
      recentVerdicts,
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, true);
    // 3 failures each with timeout → "timeout (3x)"
    assert.ok(result.message!.includes("timeout (3x)"));
  });

  // --- Cooldown tests ---

  it("fires once then respects cooldown on immediate second call", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];

    // First call — should fire.
    const result1 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result1.fired, true);

    // Second call (same skill, within 24h cooldown) — should NOT fire.
    const result2 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result2.fired, false);
  });

  it("fires again after cooldown is reset", () => {
    resetAlertCooldowns();

    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];

    // First call — should fire.
    const result1 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result1.fired, true);

    // Reset cooldown.
    resetAlertCooldowns();

    // Third call — should fire again.
    const result3 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result3.fired, true);
  });

  it("fires for different skills independently", () => {
    const traceA = makeTrace({ skillName: "skill-a", stoppedReason: "timeout", finalText: "" });
    const traceB = makeTrace({ skillName: "skill-b", stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];

    // Skill A fires.
    const resultA = checkDegradationAlert(
      failureVerdict(["timeout"]),
      traceA,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(resultA.fired, true);

    // Skill B also fires (different skill, no cooldown).
    const resultB = checkDegradationAlert(
      failureVerdict(["timeout"]),
      traceB,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(resultB.fired, true);
    assert.ok(resultB.message!.includes("skill-b"));
  });

  it("respects custom consecutiveFailures threshold", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    // Only 2 consecutive failures — not enough for default (3).
    const result3 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      { ...DEFAULT_CONFIG, consecutiveFailures: 3 }
    );
    assert.equal(result3.fired, false);

    // But enough for threshold = 2.
    const result2 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      { ...DEFAULT_CONFIG, consecutiveFailures: 2 }
    );
    assert.equal(result2.fired, true);
  });

  it("includes 'Last successful run' in the message", () => {
    const ts = Date.now() - 3600_000; // 1 hour ago
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok", timestamp: ts } as ExecutionTrace),
    ];
    const result = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, true);
    assert.ok(result.message!.includes("Last successful run"));
  });

  it("works without pre-classified verdicts using simple heuristic", () => {
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    // 2 failures (stoppedReason !== completed or empty text) + 1 success
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "aborted", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];
    const result = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined, // No pre-classified verdicts
      DEFAULT_CONFIG
    );
    assert.equal(result.fired, true);
  });
});

// ---------------------------------------------------------------------------
// createAlertCooldownTracker (per-instance isolation)
// ---------------------------------------------------------------------------

describe("createAlertCooldownTracker", () => {
  it("isolates cooldown between tracker instances", () => {
    const trackerA = createAlertCooldownTracker();
    const trackerB = createAlertCooldownTracker();

    // Tracker A fires — should update its own state.
    assert.equal(trackerA.checkAndUpdate("skill-x", 24), true);
    // Tracker A now in cooldown.
    assert.equal(trackerA.checkAndUpdate("skill-x", 24), false);
    // Tracker B is independent — not in cooldown.
    assert.equal(trackerB.checkAndUpdate("skill-x", 24), true);
  });

  it("reset() only affects the owning tracker", () => {
    const trackerA = createAlertCooldownTracker();
    const trackerB = createAlertCooldownTracker();

    trackerA.checkAndUpdate("skill-x", 24);
    trackerB.checkAndUpdate("skill-x", 24);

    // Both in cooldown.
    assert.equal(trackerA.checkAndUpdate("skill-x", 24), false);
    assert.equal(trackerB.checkAndUpdate("skill-x", 24), false);

    // Reset A only.
    trackerA.reset();
    assert.equal(trackerA.checkAndUpdate("skill-x", 24), true); // A freed
    assert.equal(trackerB.checkAndUpdate("skill-x", 24), false); // B still in cooldown
  });

  it("checkDegradationAlert uses the provided tracker", () => {
    const tracker = createAlertCooldownTracker();
    const trace = makeTrace({ stoppedReason: "timeout", finalText: "" });
    const recent = [
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "timeout", finalText: "" }),
      makeTrace({ stoppedReason: "completed", finalText: "ok" }),
    ];

    // First call — should fire.
    const result1 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      { ...DEFAULT_CONFIG, cooldownTracker: tracker }
    );
    assert.equal(result1.fired, true);

    // Second call with same tracker — should NOT fire (cooldown).
    const result2 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      { ...DEFAULT_CONFIG, cooldownTracker: tracker }
    );
    assert.equal(result2.fired, false);

    // Call with no tracker (uses default) — should fire (default is clean).
    resetAlertCooldowns();
    const result3 = checkDegradationAlert(
      failureVerdict(["timeout"]),
      trace,
      recent,
      undefined,
      DEFAULT_CONFIG
    );
    assert.equal(result3.fired, true);
  });
});
