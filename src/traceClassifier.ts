/**
 * Trace Classifier — deterministic heuristic classification of execution
 * trace outcomes.
 *
 * No LLM involved — fast, free, repeatable. The classifier examines the
 * trace's stoppedReason, finalText, tool-call count, and route confidence
 * to produce a TraceVerdict. Verdicts are approximate, not ground truth;
 * they flag patterns for human review.
 *
 * Regression detection compares the current trace against recent history
 * for the same skill. If a failure signal appears in ≥ 3 consecutive
 * traces and the skill previously had successful runs without that signal,
 * the outcome is escalated to `likely-regression`.
 *
 * See `docs/PRD-trace-observability.md` §4.2 for design rationale.
 */

import type { ExecutionTrace } from "./executionTrace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceOutcome =
  | "success"
  | "likely-failure"
  | "likely-regression"
  | "unknown";

export interface TraceVerdict {
  /** Heuristic outcome classification. */
  outcome: TraceOutcome;
  /** Human-readable signal descriptions that contributed to the verdict. */
  signals: string[];
  /** 0..1 — how confident the heuristic is. Low confidence means "review
   *  recommended," not "wrong." */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Extract the short prefix from a signal label.
 *
 * Signal labels follow the pattern `"<prefix> — <detail>"` or `"<prefix> (<detail>)"`.
 * This function returns just the prefix for compact display.
 *
 * Examples:
 *   "timeout — sub-agent hit wall clock limit" → "timeout"
 *   "error markers in output (error, failed)" → "error markers in output"
 *   "high tool-call count (28 calls, threshold 20)" → "high tool-call count"
 */
export function extractSignalPrefix(signal: string): string {
  return signal.split(/ —|\s\(/)[0] || signal;
}

/**
 * Emoji map for trace outcomes — shared across report and viewer.
 */
export const OUTCOME_EMOJI: Record<TraceOutcome, string> = {
  success: "✅",
  "likely-failure": "⚠️",
  "likely-regression": "📉",
  unknown: "❓",
};

/**
 * Format the duration of a trace (first to last tool-call timestamp)
 * as a human-readable string. Shared across report and viewer.
 */
export function formatTraceDuration(trace: ExecutionTrace): string {
  if (trace.toolCalls.length === 0) {
    return "<1s";
  }
  const firstTs = trace.toolCalls[0]!.timestamp;
  const lastTs = trace.toolCalls[trace.toolCalls.length - 1]!.timestamp;
  const diffMs = lastTs - firstTs;
  if (diffMs < 1000) return "<1s";
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`;
  const mins = Math.floor(diffMs / 60_000);
  const secs = Math.round((diffMs % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

// ---------------------------------------------------------------------------
// Classification signals
// ---------------------------------------------------------------------------

interface SignalResult {
  detected: boolean;
  label: string;
}

/**
 * Check for timeout — sub-agent hit wall clock limit.
 */
function checkTimeout(trace: ExecutionTrace): SignalResult {
  const detected = trace.stoppedReason === "timeout";
  return { detected, label: "timeout — sub-agent hit wall clock limit" };
}

/**
 * Check for inactivity — model stopped making tool calls.
 */
function checkInactivity(trace: ExecutionTrace): SignalResult {
  const detected = trace.stoppedReason === "inactivity";
  return { detected, label: "inactivity — model stopped making tool calls" };
}

/**
 * Check for abort — external cancellation.
 */
function checkAbort(trace: ExecutionTrace): SignalResult {
  const detected = trace.stoppedReason === "aborted";
  return { detected, label: "aborted — execution was cancelled externally" };
}

/**
 * Check for empty output — no text produced.
 */
function checkEmptyOutput(trace: ExecutionTrace): SignalResult {
  const detected = trace.finalText.trim().length === 0;
  return { detected, label: "empty output — no text produced" };
}

/**
 * Check for error markers in the first 200 characters of the final output.
 * Case-insensitive search for "error", "failed", "exception".
 */
function checkErrorMarkers(trace: ExecutionTrace): SignalResult {
  const head = trace.finalText.slice(0, 200).toLowerCase();
  const markers = ["error", "failed", "exception"];
  const found = markers.filter((m) => head.includes(m));
  const detected = found.length > 0;
  return {
    detected,
    label: detected
      ? `error markers in output (${found.join(", ")})`
      : "",
  };
}

/** Threshold for "high tool-call count" — possible spinning / excessive iteration. */
const HIGH_TOOL_CALL_THRESHOLD = 20;

/**
 * Check for excessive tool-call count — possible spinning or looping.
 */
function checkHighToolCallCount(trace: ExecutionTrace): SignalResult {
  const count = trace.toolCalls.length;
  const detected = count > HIGH_TOOL_CALL_THRESHOLD;
  return {
    detected,
    label: detected
      ? `high tool-call count (${count} calls, threshold ${HIGH_TOOL_CALL_THRESHOLD})`
      : "",
  };
}

/** Threshold below which the Judge was uncertain about routing. */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Check for low route confidence — Judge was uncertain.
 */
function checkLowConfidence(trace: ExecutionTrace): SignalResult {
  const confidence = trace.route.confidence;
  const detected = confidence < LOW_CONFIDENCE_THRESHOLD;
  return {
    detected,
    label: detected
      ? `low route confidence (${confidence.toFixed(2)}, threshold ${LOW_CONFIDENCE_THRESHOLD})`
      : "",
  };
}

/**
 * All signal detectors, in evaluation order. Order does not affect the
 * verdict — all signals are collected independently.
 */
const SIGNAL_DETECTORS: Array<(trace: ExecutionTrace) => SignalResult> = [
  checkTimeout,
  checkInactivity,
  checkAbort,
  checkEmptyOutput,
  checkErrorMarkers,
  checkHighToolCallCount,
  checkLowConfidence,
];

// ---------------------------------------------------------------------------
// Core classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single execution trace using deterministic heuristics.
 *
 * Classification logic:
 * - If any signal is detected → `likely-failure` with confidence based on
 *   signal count (more signals → higher confidence).
 * - If `stoppedReason === "completed"`, no signals, and output is non-empty
 *   → `success` with high confidence (0.9).
 * - Otherwise → `unknown` with low confidence (0.3).
 *
 * @param trace The completed execution trace to classify.
 * @returns A TraceVerdict with outcome, signals, and confidence.
 */
export function classifyTrace(trace: ExecutionTrace): TraceVerdict {
  const signals: string[] = [];

  for (const detector of SIGNAL_DETECTORS) {
    const result = detector(trace);
    if (result.detected) {
      signals.push(result.label);
    }
  }

  // Determine outcome and confidence.
  if (signals.length > 0) {
    // More signals → higher confidence that something went wrong.
    // Scale: 1 signal → 0.6, 2 → 0.75, 3+ → 0.9
    const confidence = signals.length >= 3
      ? 0.9
      : signals.length === 2
        ? 0.75
        : 0.6;
    return { outcome: "likely-failure", signals, confidence };
  }

  // No negative signals detected.
  if (trace.stoppedReason === "completed" && trace.finalText.trim().length > 0) {
    return { outcome: "success", signals: [], confidence: 0.9 };
  }

  // No signals but something feels off — e.g. completed with empty output
  // (should have been caught by checkEmptyOutput, but defensive).
  return { outcome: "unknown", signals: [], confidence: 0.3 };
}

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

/** Minimum number of consecutive failures to consider regression. */
const REGRESSION_CONSECUTIVE = 3;

/**
 * Upgrade a verdict to `likely-regression` if the failure pattern indicates
 * a previously-working skill has degraded.
 *
 * Conditions (all must be true):
 * 1. The current verdict is `likely-failure`.
 * 2. The skill has at least one historical success.
 * 3. The current trace plus the `recentTraces` show ≥ REGRESSION_CONSECUTIVE
 *    consecutive failures (including the current one).
 *
 * @param verdict The verdict for the current trace.
 * @param trace The current trace.
 * @param recentTraces Earlier traces for the same skill, sorted newest-first.
 *   Only the first `regressionWindowSize` traces are examined.
 * @param regressionWindowSize How many historical traces to consider (default 10).
 * @returns Updated verdict — either the original or upgraded to `likely-regression`.
 */
export function detectRegression(
  verdict: TraceVerdict,
  trace: ExecutionTrace,
  recentTraces: ExecutionTrace[],
  regressionWindowSize: number = 10
): TraceVerdict {
  if (verdict.outcome !== "likely-failure") {
    return verdict;
  }

  // Build the ordered sequence: current trace first, then recent history.
  const window = recentTraces.slice(0, regressionWindowSize);

  // Check that the skill has at least one historical success.
  const hasHistoricalSuccess = window.some(
    (t) => t.stoppedReason === "completed" && t.finalText.trim().length > 0
  );
  if (!hasHistoricalSuccess) {
    return verdict;
  }

  // Count consecutive failures from the front of the sequence.
  // "Failure" = any trace that is NOT a clean success (completed + non-empty).
  let consecutiveFailures = 0;
  for (const t of [trace, ...window]) {
    const isCleanSuccess =
      t.stoppedReason === "completed" && t.finalText.trim().length > 0;
    if (!isCleanSuccess) {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  if (consecutiveFailures >= REGRESSION_CONSECUTIVE) {
    return {
      ...verdict,
      outcome: "likely-regression",
      confidence: Math.min(verdict.confidence + 0.1, 1.0),
      signals: [
        ...verdict.signals,
        `regression — ${consecutiveFailures} consecutive failures after previous success`,
      ],
    };
  }

  return verdict;
}
