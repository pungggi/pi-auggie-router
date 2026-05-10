/**
 * Action 3 — Head/Tail Chat History Assembly.
 *
 * Deterministic, non-LLM history reducer used by the Actor/Judge loop. Two
 * strategies:
 *
 *   - "recent"   : pass through the host-provided window unchanged
 *                  (legacy behaviour; default).
 *   - "headTail" : keep the first `headMessages` and last `tailMessages`,
 *                  drop or mark the middle, then enforce per-message and
 *                  total char caps.
 *
 * The host currently only exposes `getRecentMessages(N)`, so "head" means the
 * earliest entries inside the available window — not necessarily the true
 * start of session. Documented limitation; a future host API could surface
 * session-start messages directly.
 */

import type {
  ChatMessage,
  HistoryAssemblySettings,
} from "./types.js";

const TRUNCATED_MARKER = "\n[...truncated]";
const OMITTED_MIDDLE_PREFIX = "[history-omitted-middle:";

function isOmittedMiddleMarker(m: ChatMessage): boolean {
  return m.role === "system" && m.content.startsWith(OMITTED_MIDDLE_PREFIX);
}

function capPerMessage(history: ChatMessage[], maxChars: number): ChatMessage[] {
  if (maxChars <= 0) return history;
  return history.map((m) =>
    m.content.length <= maxChars
      ? m
      : { ...m, content: m.content.slice(0, maxChars) + TRUNCATED_MARKER }
  );
}

function totalChars(history: ChatMessage[]): number {
  let n = 0;
  for (const m of history) n += m.content.length;
  return n;
}

function enforceTotalCap(
  history: ChatMessage[],
  maxTotalChars: number
): ChatMessage[] {
  if (maxTotalChars <= 0 || history.length === 0) return history;
  let current = history.slice();
  let total = totalChars(current);
  if (total <= maxTotalChars) return current;

  // 1. Sacrifice any omitted-middle marker first — it's already a placeholder
  //    for dropped content, so losing it costs nothing real.
  const markerIdx = current.findIndex(isOmittedMiddleMarker);
  if (markerIdx >= 0) {
    current.splice(markerIdx, 1);
    total = totalChars(current);
  }

  // 2. Drop interior messages, preserving the first and last entries as
  //    anchors. Pick from the geometric middle each iteration to keep what
  //    remains roughly symmetric around the two anchors.
  while (total > maxTotalChars && current.length > 2) {
    const dropIndex = Math.floor(current.length / 2);
    // dropIndex is guaranteed to be in [1, length-2] when length > 2, so the
    // anchors at 0 and length-1 are never touched.
    current.splice(dropIndex, 1);
    total = totalChars(current);
  }

  // 3. Still over (only 1–2 anchors left): truncate the last message's content
  //    so the final total — including TRUNCATED_MARKER — fits within the cap.
  if (total > maxTotalChars && current.length > 0) {
    const last = current[current.length - 1]!;
    const otherTotal = total - last.content.length;
    const budgetForLast = Math.max(0, maxTotalChars - otherTotal);
    const sliceLen = Math.max(0, budgetForLast - TRUNCATED_MARKER.length);
    current[current.length - 1] = {
      ...last,
      content: last.content.slice(0, sliceLen) + TRUNCATED_MARKER,
    };
  }
  return current;
}

/**
 * Assemble a `ChatMessage[]` suitable for injection into Actor/Judge prompts.
 * Pure: never mutates input. Empty histories pass through unchanged.
 */
export function assembleHistory(
  history: ChatMessage[],
  settings: HistoryAssemblySettings
): ChatMessage[] {
  if (history.length === 0) return [];

  if (settings.strategy === "recent") {
    const capped = capPerMessage(history, settings.maxCharsPerMessage);
    return enforceTotalCap(capped, settings.maxTotalChars);
  }

  // headTail strategy
  const head = Math.max(0, settings.headMessages | 0);
  const tail = Math.max(0, settings.tailMessages | 0);

  if (history.length <= head + tail) {
    const capped = capPerMessage(history, settings.maxCharsPerMessage);
    return enforceTotalCap(capped, settings.maxTotalChars);
  }

  const headSlice = history.slice(0, head);
  const tailSlice = history.slice(history.length - tail);
  const middleSlice = history.slice(head, history.length - tail);
  const omittedCount = middleSlice.length;
  const omittedChars = totalChars(middleSlice);

  const result: ChatMessage[] = [...headSlice];
  if (settings.middleMode === "marker") {
    result.push({
      role: "system",
      content: `${OMITTED_MIDDLE_PREFIX} ${omittedCount} message(s), ~${omittedChars} chars]`,
    });
  }
  result.push(...tailSlice);

  const capped = capPerMessage(result, settings.maxCharsPerMessage);
  return enforceTotalCap(capped, settings.maxTotalChars);
}
