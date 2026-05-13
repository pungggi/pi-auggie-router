/**
 * Trace Viewer — single-trace debugging with tool-call timeline.
 *
 * Renders a detailed view of one execution trace, showing:
 * - Metadata (model, route, outcome, duration, tool-call count)
 * - Tool-call timeline with relative timestamps, args summaries,
 *   and result preview sizes
 * - Final text output (truncated for inline display)
 *
 * Triggered via `/skill:trace-view <filename>` command.
 *
 * See `docs/PRD-trace-observability.md` §4.5 for design rationale.
 */

import type { ExecutionTrace, ToolCallEntry } from "./executionTrace.js";
import { classifyTrace, extractSignalPrefix, OUTCOME_EMOJI, formatTraceDuration } from "./traceClassifier.js";
import type { TraceOutcome, TraceVerdict } from "./traceClassifier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceViewConfig {
  /** Maximum chars of finalText to include inline. Default: 200. */
  maxFinalTextChars: number;
  /** Maximum chars of tool args summary per call. Default: 80. */
  maxArgsPreviewChars: number;
  /** Maximum number of tool calls to show in timeline. Default: 30. */
  maxTimelineEntries: number;
}

export const DEFAULT_TRACE_VIEW_CONFIG: TraceViewConfig = {
  maxFinalTextChars: 200,
  maxArgsPreviewChars: 80,
  maxTimelineEntries: 30,
};

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function stoppedReasonEmoji(reason: string): string {
  switch (reason) {
    case "timeout": return "⏰";
    case "inactivity": return "💤";
    case "aborted": return "🛑";
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// Core viewer
// ---------------------------------------------------------------------------

/**
 * Render a detailed single-trace view for debugging.
 *
 * @param filename The trace filename (for display in header).
 * @param trace The loaded execution trace.
 * @param verdict Optional pre-computed verdict. Classified automatically if omitted.
 * @param config Display configuration.
 * @returns The formatted trace view string.
 */
export function renderTraceView(
  filename: string,
  trace: ExecutionTrace,
  verdict?: TraceVerdict,
  config: TraceViewConfig = DEFAULT_TRACE_VIEW_CONFIG
): string {
  const v = verdict ?? classifyTrace(trace);
  const lines: string[] = [];

  // Header line
  const emoji = OUTCOME_EMOJI[v.outcome];
  lines.push(`🔍 Trace: ${filename}`);

  // Metadata block
  lines.push(
    `   Model: ${trace.model}  |  Route: ${trace.route.tier}, ${trace.route.complexity} complexity`
  );
  lines.push(
    `   Outcome: ${emoji} ${v.outcome}${v.signals.length > 0 ? ` (${v.signals.map(s => extractSignalPrefix(s)).join(", ")})` : ""}`
  );

  // Duration
  const duration = formatTraceDuration(trace);
  lines.push(
    `   Duration: ${duration}  |  Tool calls: ${trace.toolCalls.length}`
  );

  // Route confidence
  lines.push(
    `   Confidence: ${(trace.route.confidence * 100).toFixed(0)}%  |  Risk: ${trace.route.risk}`
  );

  // Signals (if any)
  if (v.signals.length > 0) {
    lines.push("   Signals:");
    for (const signal of v.signals) {
      lines.push(`     • ${signal}`);
    }
  }

  // Tool-call timeline
  const calls = trace.toolCalls;
  if (calls.length === 0) {
    lines.push("");
    lines.push("   Timeline: (no tool calls)");
  } else {
    lines.push("");
    lines.push("   Timeline:");

    const baseTs = calls[0]!.timestamp;
    const showAll = calls.length <= config.maxTimelineEntries;
    const displayed = showAll
      ? calls
      : [
          ...calls.slice(0, Math.ceil(config.maxTimelineEntries / 2)),
          ...calls.slice(calls.length - Math.floor(config.maxTimelineEntries / 2)),
        ];

    let lastDisplayedIndex = -1;

    for (const call of displayed) {
      // Insert ellipsis when we skip calls
      if (lastDisplayedIndex >= 0 && call.index > lastDisplayedIndex + 1) {
        const skipped = call.index - lastDisplayedIndex - 1;
        lines.push(`   ... (${skipped} calls omitted) ...`);
      }

      const offset = formatOffset(call.timestamp - baseTs);
      const server = call.serverName;
      const tool = call.toolName;
      const resultSize = formatResultSize(call);
      const argsPreview = formatArgsPreview(call, config.maxArgsPreviewChars);

      lines.push(
        `   [${offset}]  ${server} / ${tool}  ${argsPreview}  → ${resultSize}`
      );

      lastDisplayedIndex = call.index;
    }

    // Stopped reason annotation
    const reasonEmoji = stoppedReasonEmoji(trace.stoppedReason);
    if (reasonEmoji) {
      lines.push(`   ${reasonEmoji} ${trace.stoppedReason}`);
    }
  }

  // Final text
  lines.push("");
  if (trace.finalText.trim().length === 0) {
    lines.push("   Final text: (empty)");
  } else {
    const text = trace.finalText;
    if (text.length <= config.maxFinalTextChars) {
      lines.push(`   Final text:`);
      lines.push(`     ${text.replace(/\n/g, "\n     ")}`);
    } else {
      lines.push(
        `   Final text: ${text.slice(0, config.maxFinalTextChars)}... (${text.length} chars total)`
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a millisecond offset as a human-readable time string.
 */
function formatOffset(ms: number): string {
  if (ms < 1000) return "0s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m${secs.toString().padStart(2, "0")}s`;
}

/**
 * Format the result preview size for display.
 */
function formatResultSize(call: ToolCallEntry): string {
  if (call.blocked) return "⛔ blocked";
  const len = call.resultPreview.length;
  // Check if it was truncated (ends with the truncation marker pattern)
  if (call.resultPreview.includes("[...truncated,")) {
    // Extract the total from the truncation message
    const match = call.resultPreview.match(/\[...truncated,\s*(\d+)\s+total chars\]/);
    if (match) {
      return `${Number(match[1]).toLocaleString()} chars  (preview)`;
    }
  }
  return `${len.toLocaleString()} chars`;
}

/**
 * Format a short preview of tool call args.
 */
function formatArgsPreview(
  call: ToolCallEntry,
  maxChars: number
): string {
  if (!call.args || typeof call.args !== "object") return "";
  // Arrays don't have meaningful key/value previews.
  if (Array.isArray(call.args)) return "";

  // Try to extract a concise summary from common arg shapes.
  const args = call.args as Record<string, unknown>;

  // Common patterns: { query / q }, { path }, { command }, { message }
  const summaryKey = ["query", "q", "path", "command", "message", "prompt", "instruction"]
    .find(k => typeof args[k] === "string");
  if (summaryKey) {
    const val = String(args[summaryKey]);
    const label = summaryKey === "q" ? "query" : summaryKey;
    if (val.length <= maxChars) {
      return `${label}="${val}"`;
    }
    return `${label}="${val.slice(0, maxChars - 3)}..."`;
  }

  // Fallback: show first key
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const firstKey = keys[0]!;
  const val = String(args[firstKey]);
  if (val.length <= maxChars - firstKey.length - 4) {
    return `${firstKey}="${val}"`;
  }
  return `${firstKey}="${val.slice(0, Math.max(10, maxChars - firstKey.length - 7))}..."`;
}
