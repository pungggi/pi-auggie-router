/**
 * Trace Report — on-demand and automatic trace history summaries.
 *
 * Loads recent traces for a skill, classifies each, and renders a compact
 * text report suitable for `host.postSystemMessage`. Two surfaces:
 *
 * 1. **On-demand**: `/skill:trace-report <name>` — full report.
 * 2. **Auto mini-report**: after skill execution when
 *    `traceObservability.showReportAfterExecution` is enabled.
 *
 * See `docs/PRD-trace-observability.md` §4.3 for design rationale.
 */

import { ExecutionTraceStore } from "./executionTrace.js";
import type { ExecutionTrace } from "./executionTrace.js";
import { classifyTrace, detectRegression, extractSignalPrefix, OUTCOME_EMOJI, formatTraceDuration } from "./traceClassifier.js";
import type { TraceOutcome, TraceVerdict } from "./traceClassifier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceReportConfig {
  /** Maximum traces to include in the report. Default: 10. */
  maxTraces: number;
  /** Max traces before switching from inline to file output. Default: 5. */
  maxInlineTraces: number;
  /** Number of recent runs for trend calculation. Default: 5. */
  trendWindowSize: number;
}

export interface TraceReportInput {
  /** The classified verdicts (parallel to `traces`). */
  verdicts: TraceVerdict[];
  /** The raw traces, sorted newest-first. */
  traces: ExecutionTrace[];
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function outcomeLabel(outcome: TraceOutcome): string {
  switch (outcome) {
    case "success": return "Success";
    case "likely-failure": return "Likely fail";
    case "likely-regression": return "Regression";
    case "unknown": return "Unknown";
  }
}

/**
 * Build a simple ASCII bar chart segment.
 * `filled` out of `total` → repeat █ filled times + ░ for the rest.
 * Always 10 characters wide.
 */
function barChart(filled: number, total: number): string {
  const width = 10;
  const filledCount = total > 0 ? Math.round((filled / total) * width) : 0;
  return "█".repeat(filledCount) + "░".repeat(width - filledCount);
}

// ---------------------------------------------------------------------------
// Core report builder
// ---------------------------------------------------------------------------

/**
 * Generate a trace report message for a given skill.
 *
 * @param skillName The skill to report on.
 * @param input Pre-loaded traces + verdicts (newest first).
 * @param config Report configuration.
 * @returns The formatted report string.
 */
export function renderTraceReport(
  skillName: string,
  input: TraceReportInput,
  config: TraceReportConfig
): string {
  const { verdicts, traces } = input;
  const maxTraces = Math.min(config.maxTraces, traces.length);
  const relevantTraces = traces.slice(0, maxTraces);
  const relevantVerdicts = verdicts.slice(0, maxTraces);

  if (relevantTraces.length === 0) {
    return `📊 No traces found for skill "${skillName}".`;
  }

  const lines: string[] = [];

  // Header
  lines.push(
    `📊 Trace Report: skill "${skillName}" (last ${relevantTraces.length} run${relevantTraces.length === 1 ? "" : "s"})`
  );
  lines.push("");

  // Outcome distribution
  const outcomeCounts = new Map<TraceOutcome, number>();
  for (const v of relevantVerdicts) {
    outcomeCounts.set(v.outcome, (outcomeCounts.get(v.outcome) ?? 0) + 1);
  }

  const total = relevantVerdicts.length;
  for (const outcome of ["success", "likely-failure", "likely-regression", "unknown"] as TraceOutcome[]) {
    const count = outcomeCounts.get(outcome) ?? 0;
    if (count === 0) continue;
    const pct = Math.round((count / total) * 100);
    const emoji = OUTCOME_EMOJI[outcome];
    lines.push(
      `  ${emoji} ${outcomeLabel(outcome).padEnd(12)} ${barChart(count, total)}  ${count}/${total}  (${pct}%)`
    );
  }

  // Common failure signals
  const failureSignals = new Map<string, number>();
  for (const v of relevantVerdicts) {
    if (v.outcome !== "success") {
      for (const signal of v.signals) {
        const prefix = extractSignalPrefix(signal);
        failureSignals.set(prefix, (failureSignals.get(prefix) ?? 0) + 1);
      }
    }
  }

  if (failureSignals.size > 0) {
    lines.push("");
    lines.push("  Common failure signals:");
    const sorted = [...failureSignals.entries()].sort((a, b) => b[1] - a[1]);
    for (const [signal, count] of sorted) {
      lines.push(`    • ${signal} (${count}x)`);
    }
  }

  // Trend line
  const trendSize = Math.min(config.trendWindowSize, total);
  if (trendSize >= 2 && total > trendSize) {
    const recentN = relevantVerdicts.slice(0, trendSize);
    const olderN = relevantVerdicts.slice(trendSize, trendSize * 2);
    if (olderN.length > 0) {
      const recentSuccessRate = Math.round(
        (recentN.filter(v => v.outcome === "success").length / recentN.length) * 100
      );
      const olderSuccessRate = Math.round(
        (olderN.filter(v => v.outcome === "success").length / olderN.length) * 100
      );
      const direction = recentSuccessRate < olderSuccessRate ? "↓" :
        recentSuccessRate > olderSuccessRate ? "↑" : "→";
      lines.push("");
      lines.push(
        `  Trend: success rate ${olderSuccessRate}% → ${recentSuccessRate}% ${direction} over last ${trendSize} runs.`
      );
    }
  }

  // Recent traces list — truncate to maxInlineTraces to keep inline output manageable.
  // For full listing, users can request a file-based report (future enhancement).
  const inlineTraces = relevantTraces.slice(0, config.maxInlineTraces);
  const inlineVerdicts = relevantVerdicts.slice(0, config.maxInlineTraces);
  lines.push("");
  if (inlineTraces.length < relevantTraces.length) {
    lines.push(`  Recent traces (showing ${inlineTraces.length} of ${relevantTraces.length}):`);
  } else {
    lines.push("  Recent traces:");
  }
  for (let i = 0; i < inlineTraces.length; i++) {
    const t = inlineTraces[i]!;
    const v = inlineVerdicts[i]!;
    const emoji = OUTCOME_EMOJI[v.outcome];
    const filename = `${t.skillName}_${t.timestamp}.json`;
    const toolCalls = `${t.toolCalls.length} calls`;

    // Duration or stopped reason
    const duration = t.stoppedReason === "completed"
      ? formatTraceDuration(t)
      : t.stoppedReason;

    lines.push(`    ${filename}  ${emoji}  ${toolCalls}  ${duration}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mini report (auto after execution)
// ---------------------------------------------------------------------------

/**
 * Render a compact mini-report for auto-show after execution.
 * Shows only the last 3 traces with verdicts.
 */
export function renderMiniReport(
  skillName: string,
  input: TraceReportInput
): string {
  const { verdicts, traces } = input;
  const count = Math.min(3, traces.length);
  if (count === 0) {
    return `📊 No traces found for skill "${skillName}".`;
  }

  const lines: string[] = [];
  lines.push(`📊 Mini report: skill "${skillName}" (last ${count} run${count === 1 ? "" : "s"})`);

  for (let i = 0; i < count; i++) {
    const t = traces[i]!;
    const v = verdicts[i]!;
    const emoji = OUTCOME_EMOJI[v.outcome];
    const duration = t.stoppedReason === "completed"
      ? formatTraceDuration(t)
      : t.stoppedReason;
    lines.push(`  ${emoji} ${t.toolCalls.length} calls  ${duration}  ${v.outcome}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Load and classify traces for a given skill.
 *
 * Note: Regression detection here operates within a `maxTraces` window, while
 * the runtime path in `index.ts` loads all traces then slices to `regressionWindowSize`.
 * This means a report may show a trace as `likely-failure` that was upgraded to
 * `likely-regression` at runtime (if the historical success fell outside the
 * `maxTraces` bound). This is acceptable — the report is a snapshot, not
 * real-time state.
 *
 * @param traceDir Absolute path to the trace directory.
 * @param skillName Skill name to load traces for.
 * @param maxTraces Maximum traces to load and classify.
 * @param regressionWindowSize For regression detection.
 * @returns Input suitable for `renderTraceReport` or `renderMiniReport`.
 */
export function loadAndClassifyTraces(
  traceDir: string,
  skillName: string,
  maxTraces: number,
  regressionWindowSize: number
): TraceReportInput {
  const allTraces = ExecutionTraceStore.loadTraces(traceDir, skillName);
  const traces = allTraces.slice(0, maxTraces);

  const verdicts = traces.map((t, i) => {
    let v = classifyTrace(t);
    // Use remaining traces as history for regression detection.
    const history = traces.slice(i + 1);
    v = detectRegression(v, t, history, regressionWindowSize);
    return v;
  });

  return { verdicts, traces };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
