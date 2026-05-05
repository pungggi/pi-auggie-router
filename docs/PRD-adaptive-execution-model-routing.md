# PRD: Adaptive Execution Model Routing for `pi-auggie-router`

**Status:** Draft  
**Date:** 2026-05-05  
**Owner:** TBD  
**Package:** `pi-auggie-router`

## 1. Summary

Add a Prism-inspired execution model router to `pi-auggie-router`: after the existing Actor/Judge brief loop determines what the user wants, the router should classify the skill invocation by complexity and risk, then choose an appropriate sub-agent model from a configurable cheap/balanced/frontier model pool.

The goal is to reduce unnecessary frontier-model usage while preserving quality for difficult or risky coding tasks. The decision must be sticky and cache-efficient for the entire `/skill:<name>` execution, visible when configured, and bounded by explicit user/team controls.

This is **not** a replacement for the existing Auggie semantic retrieval path. It improves the model-selection step before `executeSkill(...)` runs.

## 2. Background

Today the package has two routing-related stages:

1. `src/actorJudge.ts` runs a cheap routing model to produce a `SkillBrief` and a `JudgeRubric`.
2. `src/index.ts` resolves the sub-agent model from `SKILL.md` frontmatter via `mapModel(...)` and passes it to `executeSkill(...)`.

This means the router can decide whether the task is clear enough to start, but it does not decide which execution model is economically appropriate. A simple explanation task and a risky multi-file architecture change can both run on the same static skill model.

The Augment Prism article highlights several useful principles:

- Use a small planner to choose among a pool of models.
- Route by task complexity, not by a static session-wide model picker.
- Keep the route sticky during an in-progress agent loop.
- Avoid switching unless the quality/cost benefit is worth the prompt-cache eviction cost.
- Keep prompt prefixes stable so provider prompt caching can still work.
- Surface the selected underlying model for power users/debugging.
- Allow control over routing pools and cost-vs-quality preference.

`pi-auggie-router` can implement a simpler version because `/skill:<name>` executions are already bounded task units and already pay for an Actor/Judge routing call.

## 3. Problem

Static skill model selection creates three problems:

1. **Overpaying for easy tasks**  
   Read-only summaries, small documentation changes, scoped explanations, and low-risk lookups may not need the default Sonnet/frontier model.

2. **Underpowering hard tasks**  
   If a skill pins a cheap model, complex debugging or multi-file code changes may thrash, time out, or produce lower-quality edits.

3. **Poor observability**  
   Users cannot easily tell whether a skill used a cheap, balanced, or frontier model, nor why that model was chosen.

## 4. Goals

### G1. Route execution model by task complexity and risk

Classify each `/skill:<name>` invocation into an execution tier:

- `cheap`
- `balanced`
- `frontier`

Then select a configured model for that tier.

### G2. Reuse existing Actor/Judge work where possible

Avoid adding another planner LLM call in the first implementation. Extend Actor/Judge outputs to include routing metadata.

### G3. Preserve backwards compatibility

Existing `SKILL.md` `model:` behavior must keep working by default. Users must opt into adaptive execution routing or explicitly configure how skill-pinned models interact with routing.

### G4. Make routing sticky per skill execution

Once the router selects a model for a `/skill` run, the sub-agent uses that model for the whole run. No mid-tool-loop re-routing.

### G5. Add user/team controls

Support a cost-quality preference knob and explicit model pools so users can control both aggressiveness and allowed models.

### G6. Improve observability

Optionally surface the selected tier/model in the visible system message and emit structured logs for local debugging/evaluation.

### G7. Preserve prompt-cache efficiency

Choose the execution model once before `executeSkill(...)`, keep that model fixed for the whole sub-agent run, and avoid adding volatile routing metadata to the sub-agent system prompt. Future cross-run route reuse may prefer the recent model for the same skill/session unless complexity or risk clearly justifies switching.

## 5. Non-goals

- Do not implement per-tool-call, MCP-tool-result, or mid-run model switching.
- Do not implement cross-session cache management or provider-specific cache APIs in v1.
- Do not build a cloud telemetry system.
- Do not estimate exact provider cost in v1.
- Do not modify Auggie MCP retrieval behavior.
- Do not remove `SKILL.md` `model:` support.
- Do not require model providers beyond the existing Pi host model gateway.

## 6. Users

### Primary user

A developer using `/skill:<name>` inside Pi who wants lower model spend without manually picking models per task.

### Secondary user

A team/admin configuring `.pi/settings.json` who wants safe defaults, provider restrictions, and predictable routing behavior.

### Power user

A developer who wants to see which model handled a task and tune routing preferences.

## 7. Proposed UX

### 7.1 Default behavior

Adaptive execution routing is disabled by default in the initial release to avoid changing existing behavior.

```json
{
  "auggieRouter": {
    "executionRouting": {
      "enabled": false
    }
  }
}
```

When disabled, behavior remains:

```ts
mapModel(skill.rawModel, settings.defaultProvider, settings.allowedProviderPrefixes)
```

### 7.2 Enabled behavior

```json
{
  "auggieRouter": {
    "defaultProvider": "openrouter",
    "executionRouting": {
      "enabled": true,
      "preference": "balanced",
      "surfaceDecision": true,
      "skillModelPolicy": "pin",
      "models": {
        "cheap": "anthropic/claude-3-5-haiku",
        "balanced": "anthropic/claude-3-5-sonnet",
        "frontier": "anthropic/claude-3-7-sonnet"
      }
    }
  }
}
```

Visible system message when `surfaceDecision` is true:

```text
[System]: ⚙️ Executing /skill:refactor using balanced model openrouter/anthropic/claude-3-5-sonnet. Reason: scoped small edit.
```

If `surfaceDecision` is false, keep the current message shape:

```text
[System]: ⚙️ Executing /skill:refactor (Auggie semantic retrieval running...)
```

## 8. Configuration

Add `executionRouting` under `RouterSettings`.

```ts
export type ExecutionRoutingPreference =
  | "preferCheap"
  | "balanced"
  | "preferBest";

export type ExecutionRoutingTier =
  | "cheap"
  | "balanced"
  | "frontier";

export type SkillModelPolicy =
  | "pin"
  | "prefer"
  | "ignore";

export interface ExecutionRoutingSettings {
  enabled: boolean;
  preference: ExecutionRoutingPreference;
  surfaceDecision: boolean;
  skillModelPolicy: SkillModelPolicy;
  models: Partial<Record<ExecutionRoutingTier, string>>;
}
```

### 8.1 Defaults

```ts
executionRouting: {
  enabled: false,
  preference: "balanced",
  surfaceDecision: false,
  skillModelPolicy: "pin",
  models: {
    cheap: "anthropic/claude-3-5-haiku",
    balanced: "anthropic/claude-3-5-sonnet",
    frontier: "anthropic/claude-3-7-sonnet"
  }
}
```

All configured model IDs should pass through existing `mapModel(...)` so `defaultProvider` and `allowedProviderPrefixes` continue to apply.

### 8.2 `skillModelPolicy`

| Policy | Behavior |
| --- | --- |
| `pin` | If `SKILL.md` has `model:`, use it exactly as today. If missing, adaptive routing chooses from the pool. This is the safest default. |
| `prefer` | Treat `SKILL.md` `model:` as a preferred/default model, but allow routing to upgrade/downgrade if confidence is high. |
| `ignore` | Ignore `SKILL.md` `model:` and always route from the configured pool. Useful for team-level cost control. |

## 9. Routing metadata

Extend the Judge output or add a sibling `ExecutionRoute` object returned by `runActorJudgeLoop(...)`.

Recommended new type:

```ts
export interface ExecutionRoute {
  tier: "cheap" | "balanced" | "frontier";
  complexity: "low" | "medium" | "high";
  risk:
    | "read_only"
    | "small_edit"
    | "multi_file_edit"
    | "architecture_change"
    | "unknown";
  confidence: number; // 0..1
  reason: string;
}
```

Recommended `JudgeOutcome` shape:

```ts
export interface JudgeOutcome {
  brief: SkillBrief;
  rubric: JudgeRubric;
  passed: boolean;
  iterations: number;
  route?: ExecutionRoute;
}
```

If route parsing fails, default to:

```ts
{
  tier: "balanced",
  complexity: "medium",
  risk: "unknown",
  confidence: 0,
  reason: "Routing metadata unavailable; using balanced default."
}
```

## 10. Routing policy

### 10.1 Base tier mapping

| Signals | Tier |
| --- | --- |
| Read-only explanation, summarization, documentation drafting, simple search, no edits requested | `cheap` |
| Scoped single-area edit, adding tests for known behavior, small refactor, simple bugfix with clear file scope | `balanced` |
| Multi-file change, unclear failing tests, architecture/design work, security-sensitive changes, data migrations, ambiguous high-impact edits | `frontier` |

### 10.2 Preference adjustment

After base tier is selected, apply `executionRouting.preference`:

| Preference | Adjustment |
| --- | --- |
| `preferCheap` | Allow `medium` complexity tasks to downgrade from `balanced` to `cheap` when risk is not above `small_edit` and confidence >= 0.7. Never downgrade high-risk tasks. |
| `balanced` | Use base tier. |
| `preferBest` | Upgrade `cheap` edit tasks to `balanced`; upgrade ambiguous or unknown-risk tasks to `frontier`. |

### 10.3 Safety floors

Regardless of preference:

- `architecture_change` must not route below `frontier`.
- `multi_file_edit` must not route below `balanced`.
- `unknown` risk with confidence < 0.5 must not route below `balanced`.
- If the Judge did not pass and the router asks a clarification question, recompute route after clarification or default to at least `balanced`.

### 10.4 Missing pool entries

If the selected tier is missing from `models`, fall back upward first, then downward:

- Missing `cheap` -> `balanced` -> `frontier`
- Missing `balanced` -> `frontier` -> `cheap`
- Missing `frontier` -> `balanced` -> `cheap`

If no valid model is configured, fall back to existing `mapModel(skill.rawModel, ...)` behavior.

### 10.5 Cache-aware stickiness

The router must preserve cache efficiency by treating each `/skill:<name>` invocation as one sticky execution unit:

1. Run Actor/Judge and compute `ExecutionRoute` before sub-agent execution starts.
2. Select exactly one resolved execution model before calling `executeSkill(...)`.
3. Pass that model to `host.runSubAgent(...)` and never change it during the sub-agent's tool-call loop.
4. Do not re-run the planner on Auggie MCP tool results or sub-agent follow-up messages.
5. Do not inject route tier, model name, timestamp, random IDs, or route reason into the sub-agent system prompt.
6. Keep `systemPrompt` construction deterministic: `skill.instructions`, `AUGGIE_DIRECTIVE`, and optional host appendix only.
7. Surface route decisions through system messages and structured logs, not through sub-agent prompt text.

This keeps the provider-facing prefix as stable as possible. The dynamic task information remains in the sub-agent user prompt via `renderBrief(...)`, where it already belongs.

### 10.6 Optional future route memory

A future version may add short-lived route memory to avoid unnecessary model churn across repeated invocations of the same skill in the same session.

Example policy:

```txt
If the same skill runs again within a short TTL:
  keep the previous model unless the new route is at least one tier higher
  because of higher risk/complexity, or the user preference requires an upgrade.

Only downgrade from balanced/frontier to cheap when confidence is high and risk is read_only/small_edit.
```

This is explicitly deferred from the MVP unless local logs show cross-run model churn is a meaningful cache/cost issue.

## 11. Prompt changes

Update `JUDGE_SYSTEM_PROMPT` in `src/actorJudge.ts` to request routing metadata in strict JSON.

Proposed schema:

```json
{
  "hasUserGoal": true,
  "hasRequiredInputs": true,
  "hasScopeBoundary": true,
  "isUnambiguous": true,
  "missingRequirementQuestion": null,
  "executionRoute": {
    "tier": "balanced",
    "complexity": "medium",
    "risk": "small_edit",
    "confidence": 0.82,
    "reason": "The user requested a scoped implementation change with clear files."
  }
}
```

Rules to add to the Judge prompt:

- Prefer the cheapest tier that is likely to complete the task well.
- Route read-only/context tasks to `cheap` unless the request requires deep architecture reasoning.
- Route risky multi-file or architectural changes to `frontier`.
- Do not use `frontier` merely because code is involved; use it when complexity/risk warrants it.
- If unclear, set lower confidence and choose at least `balanced`.
- Do not include volatile cache-busting details such as timestamps, run IDs, or provider cost estimates in route metadata.
- Do not instruct the sub-agent about its chosen tier/model; routing metadata is for the host/router only.

## 12. Implementation plan

### Phase 1: Types and config

- Add execution-routing types to `src/types.ts`.
- Add defaults to `DEFAULT_SETTINGS` in `src/config.ts`.
- Validate nested settings in `loadSettings(...)`.
- Add tests for config defaulting and validation.

### Phase 2: Judge route output

- Extend Judge prompt/schema in `src/actorJudge.ts`.
- Add `coerceExecutionRoute(...)` parser with safe defaults.
- Add route metadata to the `JudgeOutcome` return value.
- Add tests for valid route JSON, malformed route JSON, and missing route JSON.

### Phase 3: Model selection helper

Create `src/executionRouter.ts` with a pure helper:

```ts
export function chooseExecutionModel(input: {
  skill: ParsedSkill;
  route: ExecutionRoute | undefined;
  settings: RouterSettings;
}): {
  model: string;
  tier: ExecutionRoutingTier;
  reason: string;
  source: "skill-model" | "execution-routing" | "fallback";
}
```

Responsibilities:

- Apply `enabled` and `skillModelPolicy`.
- Apply preference adjustment and safety floors.
- Select exactly one model per `/skill` execution.
- Resolve selected model with `mapModel(...)`.
- Enforce `allowedProviderPrefixes` through `mapModel(...)`.
- Produce a display/log reason without mutating sub-agent prompts.

### Phase 4: Cache-safe wiring into router

In `src/index.ts`, replace direct `mapModel(skill.rawModel, ...)` model resolution with `chooseExecutionModel(...)`.

Cache-safety requirements for this phase:

- Compute the model once before `executeSkill(...)`.
- Pass the selected model unchanged into `executeSkill(...)`.
- Do not add route metadata to `systemPrompt` or `userPrompt` in `src/subAgent.ts`.
- Update only the host-visible execution system message when `surfaceDecision` is true.

### Phase 5: Observability

Emit structured logs via `host.log?.("info", ...)`:

```json
{
  "event": "auggie-router.execution-route",
  "skill": "refactor",
  "tier": "balanced",
  "model": "openrouter/anthropic/claude-3-5-sonnet",
  "source": "execution-routing",
  "complexity": "medium",
  "risk": "small_edit",
  "confidence": 0.82
}
```

Avoid logging user prompt content or raw chat history.

### Phase 6: Optional cache-aware route memory

If Phase 5 logs show repeated same-skill invocations bouncing between tiers, add short-lived in-memory route reuse to `RouterState` or a dedicated route-memory helper.

This phase is optional and should not ship until there is evidence that cross-run model churn materially affects cost or latency.

## 13. Acceptance criteria

### Functional

- With `executionRouting.enabled=false`, existing behavior and tests remain unchanged.
- With `executionRouting.enabled=true` and no `SKILL.md model:`, the router chooses from configured tier models.
- With `skillModelPolicy="pin"` and `SKILL.md model:` present, the router uses the skill model exactly as before.
- With `skillModelPolicy="ignore"`, the router ignores `SKILL.md model:` and chooses from the pool.
- Selected route remains fixed for the entire sub-agent run.
- The router does not re-route on MCP tool results or sub-agent follow-up calls.
- Invalid/missing route metadata falls back safely to `balanced`.
- `allowedProviderPrefixes` applies to all configured pool models.

### Cache efficiency

- The selected execution model is computed once before `executeSkill(...)` and passed unchanged to `host.runSubAgent(...)`.
- Route tier/model/reason is not injected into the sub-agent system prompt.
- System prompt construction remains deterministic for the same skill instructions, Auggie directive, and host appendix.
- Host-visible route messages and structured logs may include tier/model/reason without changing sub-agent prompt text.

### UX

- When `surfaceDecision=false`, the user-visible execution message remains current/minimal.
- When `surfaceDecision=true`, the message includes selected tier and resolved model.
- User-facing errors do not leak filesystem paths or secrets.

### Tests

Add/extend tests for:

- Config defaults.
- Config validation for nested execution-routing values.
- Route parsing/coercion.
- Preference adjustment.
- Safety floors.
- Missing model-tier fallback.
- Skill model policy behavior.
- Provider allowlist enforcement on pool models.
- Router integration message when `surfaceDecision=true`.
- Cache-safety invariant: one resolved execution model per sub-agent run.
- Prompt determinism: route metadata does not change `systemPrompt` passed to `runSubAgent(...)`.

## 14. Success metrics

Because this package does not currently meter provider cost directly, use proxy metrics first:

- Percentage of skill runs routed to each tier.
- Sub-agent stopped reason by tier.
- Duration by tier.
- Retry/failure rate by tier.
- User-visible early stop/failure messages by tier.
- Number of selected-model changes across repeated invocations of the same skill/session.
- Optional cache proxy: percentage of same-skill repeated invocations that reuse the previous selected model.

If the host later exposes token/cost usage, add:

- Estimated cost per skill run.
- Token usage per tier.
- Cost delta versus static baseline.

Target outcome after tuning:

- 20–40% of read-only/simple skill runs route to `cheap`.
- No increase in timeout/early-stop rate greater than 5% relative to baseline.
- High-risk tasks route to `frontier` or `balanced` according to safety floors.

## 15. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cheap model selected for hard task | Safety floors, confidence threshold, `preferBest` option, visible route decision. |
| New Judge schema breaks old parser assumptions | Coerce route independently and default to `balanced` on malformed route metadata. |
| Users surprised by changed skill model behavior | Keep routing disabled by default; default `skillModelPolicy` to `pin`. |
| Provider allowlist bypass through pool config | Route all pool entries through `mapModel(...)` with `allowedProviderPrefixes`. |
| Prompt injection in `SKILL.md` influences route | Existing trust boundary remains; document that skill instructions affect route classification. |
| Model churn reduces prompt-cache benefits | Make routing sticky per sub-agent run; defer cross-run route memory until logs prove it is needed. |
| Dynamic route metadata busts prompt caches | Keep route metadata out of sub-agent prompts; surface it only via host system messages/logs. |
| Extra complexity without measurable savings | Emit local structured logs to evaluate tier distribution and failures. |

## 16. Open questions

1. Should adaptive execution routing become enabled by default in a future major version?
2. Should skill authors be allowed to declare min/max tier in frontmatter, e.g. `minTier: balanced`?
3. Should `CreateRouterOptions` allow programmatic override of `chooseExecutionModel(...)` for host-specific policies?
4. Should route metadata be included in the final assistant output, or only in system/log messages?
5. Should `prefer` policy for `SKILL.md model:` ship in v1, or should v1 only support `pin` and `ignore`?
6. Should short-lived same-skill route memory be implemented after MVP, and what TTL should it use?
7. Can the Pi host expose provider token/cache metrics so the router can measure actual cache hit/miss impact instead of proxy metrics?

## 17. Recommended MVP

Implement the smallest valuable version:

1. `executionRouting.enabled`
2. `executionRouting.preference`
3. `executionRouting.surfaceDecision`
4. `executionRouting.skillModelPolicy` with only `pin` and `ignore`
5. `cheap` / `balanced` / `frontier` model pool
6. Judge-produced `ExecutionRoute`
7. Pure `chooseExecutionModel(...)` helper
8. Cache-efficiency invariants: one selected model per run, no mid-run re-routing, deterministic sub-agent system prompt
9. Structured local route logs

Defer `skillModelPolicy="prefer"`, cross-run route memory, provider-specific cache APIs, cost estimation, and custom host policy hooks until there is enough local routing data to justify the added surface area.
