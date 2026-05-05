/**
 * Phase-3 model selection helper.
 *
 * Pure function: given a parsed skill, an `ExecutionRoute` (from the Judge),
 * and the active `RouterSettings`, return the resolved sub-agent model and
 * the tier/source that produced it. The selection is sticky for the entire
 * sub-agent run — Phase 4 calls this once before `executeSkill(...)` and
 * passes the result through unchanged. See PRD §10 / §8.
 */

import { mapModel, DisallowedProviderError } from "./modelMapper.js";
import { DEFAULT_EXECUTION_ROUTE } from "./actorJudge.js";
import type {
  ExecutionRoute,
  ExecutionRoutingTier,
  ParsedSkill,
  RouterSettings,
} from "./types.js";

export interface ExecutionRouteSelection {
  /** Fully-qualified gateway model ID, ready for `runSubAgent`. */
  model: string;
  /**
   * Tier the resolved model represents. For static modes (`enabled=false`,
   * pinned `SKILL.md model:`, or legacy fallback), this is `"balanced"` as a
   * neutral sentinel; the `source` field disambiguates. UI code must not show
   * this as a routed tier unless `source === "execution-routing"`.
   */
  tier: ExecutionRoutingTier;
  /** Short, host-displayable explanation. Safe to log. */
  reason: string;
  /** Where the model came from. */
  source: "skill-model" | "execution-routing" | "fallback";
}

export interface ChooseExecutionModelInput {
  skill: ParsedSkill;
  route: ExecutionRoute | undefined;
  settings: RouterSettings;
  /** Optional hard floor applied after preference/safety adjustment. */
  minimumTier?: ExecutionRoutingTier;
}

const FALLBACK_CHAIN: Record<ExecutionRoutingTier, ExecutionRoutingTier[]> = {
  cheap: ["cheap", "balanced", "frontier"],
  balanced: ["balanced", "frontier", "cheap"],
  frontier: ["frontier", "balanced", "cheap"],
};

const TIER_RANK: Record<ExecutionRoutingTier, number> = {
  cheap: 0,
  balanced: 1,
  frontier: 2,
};

function maxTier(
  tier: ExecutionRoutingTier,
  minimumTier: ExecutionRoutingTier | undefined
): ExecutionRoutingTier {
  if (!minimumTier) return tier;
  return TIER_RANK[tier] >= TIER_RANK[minimumTier] ? tier : minimumTier;
}

/**
 * Apply PRD §10.2 preference adjustment to a base tier.
 */
function applyPreference(
  baseTier: ExecutionRoutingTier,
  route: ExecutionRoute,
  preference: RouterSettings["executionRouting"]["preference"]
): ExecutionRoutingTier {
  if (preference === "preferCheap") {
    // Downgrade balanced→cheap only when the task is medium complexity, the
    // risk is bounded to read-only / small_edit, and confidence is high.
    if (
      baseTier === "balanced" &&
      route.complexity === "medium" &&
      (route.risk === "read_only" || route.risk === "small_edit") &&
      route.confidence >= 0.7
    ) {
      return "cheap";
    }
    return baseTier;
  }
  if (preference === "preferBest") {
    // Cheap edit tasks → balanced.
    if (
      baseTier === "cheap" &&
      (route.risk === "small_edit" ||
        route.risk === "multi_file_edit" ||
        route.risk === "architecture_change")
    ) {
      return "balanced";
    }
    // Ambiguous / unknown-risk tasks → frontier.
    if (route.risk === "unknown") {
      return "frontier";
    }
    return baseTier;
  }
  return baseTier;
}

/**
 * Apply PRD §10.3 safety floors. Floors are absolute and override the
 * preference adjustment in either direction.
 */
function applySafetyFloors(
  tier: ExecutionRoutingTier,
  route: ExecutionRoute
): ExecutionRoutingTier {
  if (route.risk === "architecture_change") return "frontier";
  if (route.risk === "multi_file_edit" && tier === "cheap") return "balanced";
  if (route.risk === "unknown" && route.confidence < 0.5 && tier === "cheap") {
    return "balanced";
  }
  return tier;
}

/**
 * Resolve a tier to a fully-qualified model, walking the §10.4 fallback chain
 * if the requested tier is missing or its configured model is rejected by the
 * provider allowlist. Returns `null` when nothing in the pool resolves.
 */
function resolveTier(
  selectedTier: ExecutionRoutingTier,
  settings: RouterSettings,
  minimumTier?: ExecutionRoutingTier
): { tier: ExecutionRoutingTier; model: string } | null {
  const pool = settings.executionRouting.models;
  for (const tier of FALLBACK_CHAIN[selectedTier]) {
    if (minimumTier && TIER_RANK[tier] < TIER_RANK[minimumTier]) continue;
    const raw = pool[tier];
    if (!raw || !raw.trim()) continue;
    try {
      const resolved = mapModel(
        raw,
        settings.defaultProvider,
        settings.allowedProviderPrefixes
      );
      return { tier, model: resolved };
    } catch (err) {
      if (err instanceof DisallowedProviderError) continue;
      throw err;
    }
  }
  return null;
}

/**
 * Phase-3 entry point. See PRD §8 / §10. Pure: no logging, no host calls,
 * no mutation of inputs.
 */
export function chooseExecutionModel(
  input: ChooseExecutionModelInput
): ExecutionRouteSelection {
  const { skill, settings } = input;
  const route = input.route ?? DEFAULT_EXECUTION_ROUTE;
  const cfg = settings.executionRouting;
  const skillModelPolicy = cfg.skillModelPolicy === "pin" ? "pin" : "ignore";

  // 1. Adaptive routing disabled — preserve legacy behavior exactly.
  if (!cfg.enabled) {
    const model = mapModel(
      skill.rawModel,
      settings.defaultProvider,
      settings.allowedProviderPrefixes
    );
    return {
      model,
      tier: "balanced",
      reason: skill.rawModel
        ? "Adaptive routing disabled; using SKILL.md model."
        : "Adaptive routing disabled; using default model.",
      source: skill.rawModel ? "skill-model" : "fallback",
    };
  }

  // 2. Pin policy with a SKILL.md model — honour it exactly.
  if (skillModelPolicy === "pin" && skill.rawModel && skill.rawModel.trim()) {
    const model = mapModel(
      skill.rawModel,
      settings.defaultProvider,
      settings.allowedProviderPrefixes
    );
    return {
      model,
      tier: "balanced",
      reason: "skillModelPolicy=pin; SKILL.md model honoured.",
      source: "skill-model",
    };
  }

  // 3. Adaptive selection: route → preference → safety floors → pool resolve.
  const baseTier = route.tier;
  const preferred = applyPreference(baseTier, route, cfg.preference);
  const safetyFloored = applySafetyFloors(preferred, route);
  const floored = maxTier(safetyFloored, input.minimumTier);
  const resolved = resolveTier(floored, settings, input.minimumTier);

  if (resolved) {
    return {
      model: resolved.model,
      tier: resolved.tier,
      reason: buildAdaptiveReason(route, baseTier, floored, resolved.tier),
      source: "execution-routing",
    };
  }

  // 4. Pool produced nothing usable — fall back to the legacy mapModel path
  //    so the skill still runs. PRD §10.4 last clause.
  const fallbackRawModel = input.minimumTier ? undefined : skill.rawModel;
  const fallbackModel = mapModel(
    fallbackRawModel,
    settings.defaultProvider,
    settings.allowedProviderPrefixes
  );
  return {
    model: fallbackModel,
    tier: input.minimumTier ?? "balanced",
    reason: fallbackRawModel && fallbackRawModel.trim()
      ? "Execution-routing pool unavailable; used legacy SKILL.md model resolution."
      : "Execution-routing pool unavailable; used legacy default model resolution.",
    source: "fallback",
  };
}

function buildAdaptiveReason(
  route: ExecutionRoute,
  baseTier: ExecutionRoutingTier,
  flooredTier: ExecutionRoutingTier,
  resolvedTier: ExecutionRoutingTier
): string {
  const parts: string[] = [];
  parts.push(
    `route ${baseTier} (complexity=${route.complexity}, risk=${route.risk}, confidence=${route.confidence.toFixed(2)})`
  );
  if (flooredTier !== baseTier) {
    parts.push(`adjusted to ${flooredTier} via preference/safety floors`);
  }
  if (resolvedTier !== flooredTier) {
    parts.push(`pool fallback resolved ${resolvedTier}`);
  }
  return parts.join("; ");
}
