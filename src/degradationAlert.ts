/**
 * Degradation Alert — proactive notification when a skill's performance
 * degrades over consecutive runs.
 *
 * Conditions (all must be true to fire an alert):
 * 1. The last N traces (configurable, default 3) all have outcome !== "success".
 * 2. The skill has at least one historical success (no false alerts on new skills).
 * 3. The alert hasn't been shown for this skill within the cooldown window.
 *
 * The alert is delivered as a system message via `host.postSystemMessage`.
 * Cooldown state is kept in-memory (resets on router restart, which is fine
 * — the cooldown is a "don't nag" guard, not a persistent feature).
 *
 * See `docs/PRD-trace-observability.md` §4.4 for design rationale.
 */

import type { TraceVerdict } from "./traceClassifier.js";
import { extractSignalPrefix } from "./traceClassifier.js";
import type { ExecutionTrace } from "./executionTrace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DegradationAlertConfig {
  /** Enable/disable degradation alerts entirely. */
  enabled: boolean;
  /** Number of consecutive failures required to trigger. Default: 3. */
  consecutiveFailures: number;
  /** Cooldown in hours between repeated alerts for the same skill. Default: 24. */
  cooldownHours: number;
  /** Optional cooldown tracker for per-instance isolation. Uses default module-level tracker if not provided. */
  cooldownTracker?: ReturnType<typeof createAlertCooldownTracker>;
}

export interface DegradationAlertResult {
  /** Whether an alert was fired. */
  fired: boolean;
  /** The formatted alert message (if fired), for testing. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Cooldown tracker factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh cooldown tracker. Each router instance gets its own tracker
 * so multiple routers in the same process don't share state.
 */
export function createAlertCooldownTracker() {
  const cooldownMap = new Map<string, number>();

  return {
    /** Reset all cooldown state (for tests). */
    reset(): void {
      cooldownMap.clear();
    },

    /**
     * Check whether an alert for the given skill is allowed given the cooldown.
     * If allowed, updates the cooldown timestamp (call only when actually firing).
     */
    checkAndUpdate(skillName: string, cooldownHours: number): boolean {
      const now = Date.now();
      const lastAlert = cooldownMap.get(skillName);
      if (lastAlert !== undefined && now - lastAlert < cooldownHours * 60 * 60 * 1000) {
        return false; // Still in cooldown.
      }
      cooldownMap.set(skillName, now);
      return true;
    },
  };
}

/**
 * Default module-level cooldown tracker for backward compatibility and
 * standalone usage. Router instances should create their own via
 * `createAlertCooldownTracker()`.
 */
const defaultTracker = createAlertCooldownTracker();

/**
 * Reset the default module-level cooldown state.
 * For tests using the default tracker. Router-scoped tests should call
 * `tracker.reset()` directly.
 */
export function resetAlertCooldowns(): void {
  defaultTracker.reset();
}

// ---------------------------------------------------------------------------
// Signal aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate signal labels from multiple verdicts into a compact summary.
 * Returns a map of signal prefix → count, e.g. "timeout" → 3.
 */
function aggregateSignals(
  verdicts: TraceVerdict[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of verdicts) {
    for (const signal of v.signals) {
      const prefix = extractSignalPrefix(signal);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Format aggregated signals as "signal (Nx), signal (Nx)".
 */
function formatSignals(counts: Map<string, number>): string {
  const entries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1]); // Most frequent first.
  return entries
    .map(([signal, count]) => `${signal} (${count}x)`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Core alert logic
// ---------------------------------------------------------------------------

/**
 * Check whether a degradation alert should be fired for the given skill,
 * and format the alert message if so.
 *
 * This function is a pure decision function — it does NOT post the system
 * message. The caller (index.ts) is responsible for posting.
 *
 * @param currentVerdict The classified verdict for the just-completed trace.
 * @param currentTrace The just-completed trace.
 * @param recentTraces Historical traces for the same skill (newest first).
 * @param recentVerdicts Classified verdicts for `recentTraces`, same order.
 *   If not provided, traces are classified using a simple heuristic
 *   (completed + non-empty → success). This is a convenience for callers
 *   that don't have pre-classified verdicts.
 * @param config Alert configuration.
 * @returns Alert result indicating whether the alert fired and the message.
 */
export function checkDegradationAlert(
  currentVerdict: TraceVerdict,
  currentTrace: ExecutionTrace,
  recentTraces: ExecutionTrace[],
  recentVerdicts: TraceVerdict[] | undefined,
  config: DegradationAlertConfig
): DegradationAlertResult {
  if (!config.enabled) {
    return { fired: false };
  }

  // Only check when the current trace is a failure or regression.
  if (currentVerdict.outcome === "success") {
    return { fired: false };
  }

  // Simple classification for historical traces if verdicts not provided.
  const verdicts = recentVerdicts ?? recentTraces.map(simpleClassify);

  // Build the sequence: current verdict first, then recent history.
  const sequence: TraceVerdict[] = [currentVerdict, ...verdicts];

  // Count consecutive failures from the front.
  let consecutiveFailures = 0;
  for (const v of sequence) {
    if (v.outcome !== "success") {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  // Must meet the threshold.
  if (consecutiveFailures < config.consecutiveFailures) {
    return { fired: false };
  }

  // Must have at least one historical success (not a skill that never worked).
  const hasHistoricalSuccess = verdicts.some(
    (v) => v.outcome === "success"
  );
  if (!hasHistoricalSuccess) {
    return { fired: false };
  }

  // Cooldown check.
  const tracker = config.cooldownTracker ?? defaultTracker;
  if (!tracker.checkAndUpdate(currentTrace.skillName, config.cooldownHours)) {
    return { fired: false };
  }

  // Fire the alert — format the message.
  const message = formatAlertMessage(
    currentTrace.skillName,
    consecutiveFailures,
    sequence.slice(0, consecutiveFailures),
    recentTraces
  );

  return { fired: true, message };
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Format a human-readable degradation alert message.
 *
 * Format:
 * ```
 * ⚠️ Degradation detected: skill "refactor" has failed 3 consecutive times.
 *    Signals: timeout (3x), high tool-call count (2x).
 *    Last successful run: 2026-05-11 09:30.
 * ```
 */
function formatAlertMessage(
  skillName: string,
  consecutiveFailures: number,
  failureVerdicts: TraceVerdict[],
  recentTraces: ExecutionTrace[]
): string {
  const lines: string[] = [];

  // Line 1: summary
  lines.push(
    `⚠️ Degradation detected: skill "${skillName}" has failed ${consecutiveFailures} consecutive times.`
  );

  // Line 2: aggregated signals
  const signalCounts = aggregateSignals(failureVerdicts);
  if (signalCounts.size > 0) {
    lines.push(`   Signals: ${formatSignals(signalCounts)}.`);
  }

  // Line 3: last successful run timestamp
  const lastSuccess = recentTraces.find(
    (t) => t.stoppedReason === "completed" && t.finalText.trim().length > 0
  );
  if (lastSuccess) {
    const date = new Date(lastSuccess.timestamp);
    const formatted = date.toLocaleString();
    lines.push(`   Last successful run: ${formatted}.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple heuristic classification for historical traces that weren't
 * run through the full classifier. Used when the caller doesn't have
 * pre-classified verdicts.
 */
function simpleClassify(trace: ExecutionTrace): TraceVerdict {
  const isCleanSuccess =
    trace.stoppedReason === "completed" && trace.finalText.trim().length > 0;
  return {
    outcome: isCleanSuccess ? "success" : "likely-failure",
    signals: [],
    confidence: isCleanSuccess ? 0.9 : 0.5,
  };
}
