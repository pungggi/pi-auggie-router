/**
 * Action 4 — Context Budget by Execution Tier.
 *
 * Pure helper: given the active settings and the effective route tier produced
 * by the Judge (after safety floors), return the sub-agent context budget the
 * router should use for this run. When `contextBudgets.enabled` is false, the
 * top-level `overflowCeilingBytes` is returned unchanged so legacy behaviour
 * is preserved.
 *
 * Note: history budgets are intentionally NOT tier-driven yet — history must
 * be assembled before the route is known. See doc Action 4 for the MVP scope.
 */

import type { ExecutionRoutingTier, RouterSettings } from "./types.js";

export interface EffectiveContextBudget {
  /** Auggie overflow ceiling, bytes. */
  overflowCeilingBytes: number;
  /** Tier the budget was selected for (informational; safe to log). */
  tier: ExecutionRoutingTier;
  /** Whether a tier-specific ceiling value was applied. */
  active: boolean;
  /** Where the ceiling came from. */
  source: "static" | "tier" | "tier-fallback";
}

export function chooseContextBudget(
  settings: RouterSettings,
  tier: ExecutionRoutingTier
): EffectiveContextBudget {
  const cb = settings.contextBudgets;
  if (!cb.enabled) {
    return {
      overflowCeilingBytes: settings.overflowCeilingBytes,
      tier,
      active: false,
      source: "static",
    };
  }
  const ceiling = cb.overflowCeilingBytes[tier];
  if (typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0) {
    return {
      overflowCeilingBytes: ceiling,
      tier,
      active: true,
      source: "tier",
    };
  }
  return {
    overflowCeilingBytes: settings.overflowCeilingBytes,
    tier,
    active: true,
    source: "tier-fallback",
  };
}
