/**
 * Conservative final-output sanitizer for sub-agent results.
 *
 * Goals:
 *   - Remove clearly-marked internal tool traces (MCP envelopes,
 *     `tool_use` / `tool_result` fenced blocks, raw codebase-retrieval dumps).
 *   - Cap total output size so a runaway sub-agent cannot pollute the main
 *     thread's chat history (and therefore future `historyWindow` slices).
 *   - NEVER silently drop legitimate code blocks (ts/js/json/py/…).
 *
 * The sanitizer logs only counts and sizes — never removed content.
 */

import type { OutputSanitizerSettings } from "./types.js";

export interface SanitizeResult {
  text: string;
  removedSections: number;
  truncated: boolean;
  originalChars: number;
  finalChars: number;
}

/** Fenced-code-block labels treated as INTERNAL traces (to strip). */
const TRACE_FENCE_LABELS: ReadonlySet<string> = new Set([
  "tool_use",
  "tool_result",
  "tool-use",
  "tool-result",
  "mcp",
  "mcp_envelope",
  "codebase-retrieval",
  "auggie",
  "scratchpad",
  "internal",
]);

/**
 * Match a fenced code block: `\`\`\`label\n...\n\`\`\``. Captures the label
 * (group 1). Multiline, non-greedy.
 */
const FENCED_BLOCK = /```([A-Za-z0-9_\-]+)\r?\n[\s\S]*?\r?\n```/g;

/**
 * Match a bare MCP-style JSON envelope on its own block — e.g. lines that
 * start with `{"jsonrpc":"2.0"` or carry `tool_use_id` / `tool_call_id`.
 * Conservative: only removes when at start of line and self-contained on
 * the same line. The bare `"type"` key alone is intentionally NOT a trigger
 * (too broad — would match legitimate JSON examples in answers).
 */
const BARE_MCP_ENVELOPE =
  /^\s*\{"(?:jsonrpc|tool_use_id|tool_call_id)"[^\n]{0,4000}\}\s*$/gm;

export function sanitizeFinalText(
  text: string,
  options: OutputSanitizerSettings
): SanitizeResult {
  const originalChars = text.length;

  if (!options.enabled) {
    return {
      text,
      removedSections: 0,
      truncated: false,
      originalChars,
      finalChars: originalChars,
    };
  }

  let removed = 0;
  let out = text;

  if (options.stripToolTraces) {
    out = out.replace(FENCED_BLOCK, (match, label: string) => {
      if (TRACE_FENCE_LABELS.has(label.toLowerCase())) {
        removed++;
        return "";
      }
      return match;
    });
    out = out.replace(BARE_MCP_ENVELOPE, () => {
      removed++;
      return "";
    });
    // Only normalize whitespace if we actually removed something — avoid
    // mutating clean answers that happen to start or end with newlines.
    if (removed > 0) {
      out = out.replace(/\n{3,}/g, "\n\n").trim();
    }
  }

  let truncated = false;
  const cap = options.finalOutputMaxChars;
  if (cap > 0 && out.length > cap) {
    truncated = true;
    const marker = `\n\n[…final output truncated by output sanitizer at ${cap} chars]`;
    // Honor the cap strictly: the marker counts against the budget.
    const sliceTo = Math.max(0, cap - marker.length);
    out = out.slice(0, sliceTo) + marker;
  }

  return {
    text: out,
    removedSections: removed,
    truncated,
    originalChars,
    finalChars: out.length,
  };
}
