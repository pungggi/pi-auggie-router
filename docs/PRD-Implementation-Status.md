# PRD Implementation Status: Adaptive Execution Model Routing

**Source PRD:** [`docs/PRD-adaptive-execution-model-routing.md`](./PRD-adaptive-execution-model-routing.md)  
**Package:** `pi-auggie-router`  
**Status owner:** TBD  
**Last updated:** 2026-05-05  
**Overall status:** Phases 1–3 complete — `chooseExecutionModel` ready; Phase 4 (router wiring) next

## 1. Status legend

| Marker | Meaning |
| --- | --- |
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Done |
| `[!]` | Blocked / needs decision |
| `[d]` | Deferred |

## 2. Milestone overview

| Phase | Name | Status | Notes |
| --- | --- | --- | --- |
| 0 | PRD and tracking docs | `[x]` | PRD and this status tracker created. |
| 1 | Types and config | `[x]` | Types in `src/types.ts`; defaults + validation in `src/config.ts`; tests in `tests/config.test.ts`. |
| 2 | Judge route output | `[x]` | Judge prompt extended; `coerceExecutionRoute` parses with safe defaults; `JudgeOutcome.route` always populated; tests in `tests/actorJudge.test.ts`. |
| 3 | Model selection helper | `[x]` | Pure `chooseExecutionModel` in `src/executionRouter.ts`; preference + safety floors + pool fallback chain; tests in `tests/executionRouter.test.ts`. |
| 4 | Cache-safe router wiring | `[ ]` | Replace direct `mapModel(...)` resolution in `src/index.ts`. |
| 5 | Observability | `[ ]` | Add structured route logs and optional surfaced decision. |
| 6 | Optional cache-aware route memory | `[d]` | Deferred until logs prove same-skill model churn matters. |
| 7 | README/docs update | `[ ]` | Document new settings and behavior after implementation. |
| 8 | Release readiness | `[ ]` | Full test/lint/build pass and changelog/release notes. |

## 3. Phase checklist

### Phase 0 — PRD and tracking docs

- `[x]` Draft adaptive execution model routing PRD.
- `[x]` Integrate cache-efficiency requirements into PRD.
- `[x]` Create implementation status tracker.

Deliverables:

- `[x]` `docs/PRD-adaptive-execution-model-routing.md`
- `[x]` `docs/PRD-Implementation-Status.md`

### Phase 1 — Types and config

Goal: add the configuration surface without changing default runtime behavior.

Tasks:

- `[x]` Add `ExecutionRoutingPreference` type:
  - `preferCheap`
  - `balanced`
  - `preferBest`
- `[x]` Add `ExecutionRoutingTier` type:
  - `cheap`
  - `balanced`
  - `frontier`
- `[x]` Add `SkillModelPolicy` type:
  - `pin`
  - `ignore`
- `[d]` Defer `skillModelPolicy="prefer"` until the policy is implemented.
  - Note: the PRD still lists `prefer` as an eventual policy, but Phase 1 intentionally rejects it in config until behavior exists.
- `[x]` Add `ExecutionRoutingSettings` interface.
- `[x]` Add `executionRouting` to `RouterSettings`.
- `[x]` Add defaults to `DEFAULT_SETTINGS`:

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

- `[x]` Validate nested `executionRouting` settings in `loadSettings(...)`.
- `[x]` Preserve existing behavior when `executionRouting.enabled=false`.
- `[x]` Ensure all configured model IDs still pass through `mapModel(...)` before execution. *(landed in Phase 3 via `chooseExecutionModel`)*
- `[x]` Re-export new public types and `DEFAULT_EXECUTION_ROUTING` from `src/index.ts`.
- `[x]` Return fresh nested settings from `loadSettings(...)` to avoid shared mutation of defaults.

Files likely touched:

- `src/types.ts`
- `src/config.ts`
- `tests/*config*.test.ts` or existing config-related tests

### Phase 2 — Judge route output

Goal: reuse the existing Actor/Judge loop as the lightweight planner.

Tasks:

- `[x]` Add `ExecutionRoute` type:

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
    confidence: number;
    reason: string;
  }
  ```

- `[x]` Extend `JudgeOutcome` with `route: ExecutionRoute` (always populated; never undefined).
- `[x]` Update `JUDGE_SYSTEM_PROMPT` strict JSON schema to include `executionRoute`.
- `[x]` Add prompt rules:
  - prefer cheapest tier likely to complete well
  - route read-only/context tasks to `cheap`
  - route risky multi-file/architecture work to `frontier`
  - choose at least `balanced` when unclear
  - do not include volatile cache-busting data
  - do not instruct the sub-agent about tier/model
- `[x]` Implement `coerceExecutionRoute(...)`.
- `[x]` Default malformed/missing route metadata to:

  ```ts
  {
    tier: "balanced",
    complexity: "medium",
    risk: "unknown",
    confidence: 0,
    reason: "Routing metadata unavailable; using balanced default."
  }
  ```

- `[x]` Freeze `DEFAULT_EXECUTION_ROUTE` so exported fallback metadata cannot be mutated by consumers.
- `[x]` Keep old Judge responses compatible where possible.

Files likely touched:

- `src/actorJudge.ts`
- `src/types.ts`
- `tests/actorJudge.test.ts`

### Phase 3 — Model selection helper

Goal: isolate model-routing policy in a pure, well-tested helper.

Tasks:

- `[x]` Create `src/executionRouter.ts`.
- `[x]` Implement `chooseExecutionModel(...)`:

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

- `[x]` Apply `executionRouting.enabled`.
- `[x]` Apply `skillModelPolicy`.
- `[x]` Apply base tier mapping.
- `[x]` Apply `preference` adjustment.
- `[x]` Apply safety floors:
  - `architecture_change` never below `frontier`
  - `multi_file_edit` never below `balanced`
  - `unknown` risk with confidence `< 0.5` never below `balanced`
- `[x]` Implement missing-pool-entry fallback:
  - missing `cheap` -> `balanced` -> `frontier`
  - missing `balanced` -> `frontier` -> `cheap`
  - missing `frontier` -> `balanced` -> `cheap`
- `[x]` Resolve selected models through `mapModel(...)`.
- `[x]` Enforce `allowedProviderPrefixes` through `mapModel(...)`.
- `[x]` Return display/log reason without mutating sub-agent prompts.

Files likely touched:

- `src/executionRouter.ts`
- `src/index.ts` exports, if needed
- `tests/executionRouter.test.ts`

### Phase 4 — Cache-safe router wiring

Goal: replace static model resolution with adaptive selection while preserving cache efficiency.

Tasks:

- `[ ]` Replace direct model resolution in `src/index.ts`:

  ```ts
  mapModel(skill.rawModel, settings.defaultProvider, settings.allowedProviderPrefixes)
  ```

  with `chooseExecutionModel(...)`.

- `[ ]` Compute the selected model exactly once before `executeSkill(...)`.
- `[ ]` Pass selected model unchanged as `resolvedModel`.
- `[ ]` Ensure no mid-run, per-tool-call, MCP-tool-result, or sub-agent-follow-up re-routing exists.
- `[ ]` Do not add route metadata to `systemPrompt` in `src/subAgent.ts`.
- `[ ]` Do not add route metadata to `userPrompt` unless explicitly accepted later; MVP should keep prompts unchanged except existing brief rendering.
- `[ ]` Keep `systemPrompt` deterministic:
  - `skill.instructions`
  - `AUGGIE_DIRECTIVE`
  - optional host appendix
- `[ ]` Preserve existing behavior when routing is disabled.

Files likely touched:

- `src/index.ts`
- `src/subAgent.ts` only if tests require verifying no prompt mutation
- `tests/router.test.ts`

### Phase 5 — Observability

Goal: make routing decisions debuggable without exposing prompt content or hurting cacheability.

Tasks:

- `[ ]` Add optional host-visible route decision when `executionRouting.surfaceDecision=true`.
- `[ ]` Preserve current minimal execution message when `surfaceDecision=false`.
- `[ ]` Emit structured local log through `host.log?.("info", ...)`:

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

- `[ ]` Do not log raw user prompt content.
- `[ ]` Do not log raw chat history.
- `[ ]` Do not log secrets or file-system paths beyond existing safe behavior.

Files likely touched:

- `src/index.ts`
- `tests/router.test.ts`

### Phase 6 — Optional cache-aware route memory

Status: deferred from MVP.

Entry criteria:

- `[ ]` Phase 5 route logs show repeated same-skill invocations bouncing between tiers/models.
- `[ ]` Model churn appears to materially affect cost or latency.
- `[ ]` A TTL and reuse policy are agreed.

Potential tasks:

- `[d]` Add short-lived in-memory route memory to `RouterState` or a dedicated helper.
- `[d]` Reuse previous model for same skill/session within TTL unless new risk/complexity justifies upgrade.
- `[d]` Only downgrade to `cheap` when confidence is high and risk is `read_only` or `small_edit`.
- `[d]` Add tests for reuse, upgrade, downgrade, and TTL expiry.

### Phase 7 — README/docs update

Goal: document the feature after behavior and config are implemented.

Tasks:

- `[ ]` Update README configuration example with `executionRouting`.
- `[ ]` Document defaults.
- `[ ]` Document `skillModelPolicy`.
- `[ ]` Document cache-efficiency invariant: one selected model per `/skill` run.
- `[ ]` Document `surfaceDecision` behavior.
- `[ ]` Document provider allowlist enforcement for pool models.
- `[ ]` Add migration note: disabled by default, existing behavior preserved.

Files likely touched:

- `README.md`
- `docs/PRD-adaptive-execution-model-routing.md`, if implementation diverges from PRD
- `docs/PRD-Implementation-Status.md`

### Phase 8 — Release readiness

Tasks:

- `[ ]` Run `npm test`.
- `[ ]` Run `npm run lint`.
- `[ ]` Run `npm run build`.
- `[ ]` Confirm generated `dist/` output is updated if this package tracks build artifacts.
- `[ ]` Confirm package exports include any new public helpers/types intended for consumers.
- `[ ]` Prepare release notes.
- `[ ]` Decide semver bump.

## 4. Acceptance criteria tracker

### Functional

- `[ ]` With `executionRouting.enabled=false`, existing behavior and tests remain unchanged.
- `[ ]` With `executionRouting.enabled=true` and no `SKILL.md model:`, the router chooses from configured tier models.
- `[ ]` With `skillModelPolicy="pin"` and `SKILL.md model:` present, the router uses the skill model exactly as before.
- `[ ]` With `skillModelPolicy="ignore"`, the router ignores `SKILL.md model:` and chooses from the pool.
- `[ ]` Selected route remains fixed for the entire sub-agent run.
- `[ ]` The router does not re-route on MCP tool results or sub-agent follow-up calls.
- `[ ]` Invalid/missing route metadata falls back safely to `balanced`.
- `[ ]` `allowedProviderPrefixes` applies to all configured pool models.

### Cache efficiency

- `[ ]` The selected execution model is computed once before `executeSkill(...)`.
- `[ ]` The selected execution model is passed unchanged to `host.runSubAgent(...)`.
- `[ ]` Route tier/model/reason is not injected into the sub-agent system prompt.
- `[ ]` System prompt construction remains deterministic for the same skill instructions, Auggie directive, and host appendix.
- `[ ]` Host-visible route messages and structured logs can include tier/model/reason without changing sub-agent prompt text.

### UX

- `[ ]` When `surfaceDecision=false`, the user-visible execution message remains current/minimal.
- `[ ]` When `surfaceDecision=true`, the message includes selected tier and resolved model.
- `[ ]` User-facing errors do not leak filesystem paths or secrets.

## 5. Test tracker

Add or extend tests for:

- `[x]` Config defaults.
- `[x]` Config validation for nested execution-routing values.
- `[x]` Route parsing/coercion.
- `[x]` Malformed route metadata fallback.
- `[x]` Missing route metadata fallback.
- `[x]` Preference adjustment.
- `[x]` Safety floors.
- `[x]` Missing model-tier fallback.
- `[x]` `skillModelPolicy="pin"`.
- `[x]` `skillModelPolicy="ignore"`.
- `[d]` `skillModelPolicy="prefer"` policy behavior; deferred beyond MVP.
- `[x]` `skillModelPolicy="prefer"` is rejected by config validation until implemented.
- `[x]` Provider allowlist enforcement on pool models.
- `[ ]` Router integration message when `surfaceDecision=true`.
- `[ ]` Router integration message remains minimal when `surfaceDecision=false`.
- `[ ]` Cache-safety invariant: one resolved execution model per sub-agent run.
- `[ ]` Prompt determinism: route metadata does not change `systemPrompt` passed to `runSubAgent(...)`.
- `[ ]` Existing router tests pass unchanged when routing is disabled.

## 6. Metrics tracker

Initial proxy metrics to log or inspect locally:

- `[ ]` Percentage of skill runs routed to each tier.
- `[ ]` Sub-agent stopped reason by tier.
- `[ ]` Duration by tier.
- `[ ]` Retry/failure rate by tier.
- `[ ]` User-visible early stop/failure messages by tier.
- `[ ]` Number of selected-model changes across repeated invocations of the same skill/session.
- `[ ]` Optional cache proxy: percentage of same-skill repeated invocations that reuse the previous selected model.

Future metrics if host/provider usage is exposed:

- `[d]` Estimated cost per skill run.
- `[d]` Token usage per tier.
- `[d]` Cost delta versus static baseline.
- `[d]` Provider prompt-cache hit/miss signal, if available.

Target outcomes after tuning:

- `[ ]` 20–40% of read-only/simple skill runs route to `cheap`.
- `[ ]` No increase in timeout/early-stop rate greater than 5% relative to baseline.
- `[ ]` High-risk tasks route to `frontier` or `balanced` according to safety floors.

## 7. Risk tracker

| Risk | Status | Mitigation | Owner |
| --- | --- | --- | --- |
| Cheap model selected for hard task | `[ ]` | Safety floors, confidence threshold, `preferBest`, visible route decision. | TBD |
| New Judge schema breaks old parser assumptions | `[ ]` | Coerce route independently and default to `balanced`. | TBD |
| Users surprised by changed skill model behavior | `[ ]` | Disabled by default; default `skillModelPolicy` to `pin`. | TBD |
| Provider allowlist bypass through pool config | `[ ]` | Route all pool entries through `mapModel(...)`. | TBD |
| Prompt injection in `SKILL.md` influences route | `[ ]` | Keep existing trust boundary documented. | TBD |
| Model churn reduces prompt-cache benefits | `[ ]` | Sticky per sub-agent run; defer cross-run memory until logs prove need. | TBD |
| Dynamic route metadata busts prompt caches | `[ ]` | Keep route metadata out of sub-agent prompts. | TBD |
| Extra complexity without measurable savings | `[ ]` | Add structured local logs and evaluate tier distribution/failures. | TBD |

## 8. Open decision tracker

| Decision | Status | Options | Current recommendation |
| --- | --- | --- | --- |
| Enable adaptive routing by default in future major version? | `[!]` | yes / no / only after telemetry | No for MVP; revisit after logs. |
| Support skill frontmatter `minTier` / `maxTier`? | `[!]` | yes / no / later | Defer. |
| Expose programmatic `chooseExecutionModel(...)` override? | `[!]` | yes / no / later | Defer. |
| Include route metadata in final assistant output? | `[!]` | final output / system message / logs only | System message and logs only. |
| Ship `skillModelPolicy="prefer"` in v1? | `[d]` | include / defer | Deferred; config rejects `prefer` until policy behavior is implemented. |
| Add same-skill route memory after MVP? | `[!]` | yes / no / after metrics | After metrics only. |
| Ask Pi host for token/cache metrics? | `[!]` | yes / no / later | Later; not required for MVP. |

## 9. Current implementation notes

As of 2026-05-05:

- Existing code still resolves execution model from `SKILL.md` frontmatter through `mapModel(...)`.
- Existing Actor/Judge loop returns `brief`, `rubric`, `passed`, `iterations`, and an always-populated `route`.
- Adaptive execution routing has not been wired into execution yet.
- Cache-efficiency requirements are documented but not yet enforced by tests.

Relevant current files:

- `src/actorJudge.ts`
- `src/config.ts`
- `src/index.ts`
- `src/modelMapper.ts`
- `src/subAgent.ts`
- `src/types.ts`
- `tests/actorJudge.test.ts`
- `tests/modelMapper.test.ts`
- `tests/router.test.ts`

## 10. Progress log

| Date | Change | Author | Notes |
| --- | --- | --- | --- |
| 2026-05-05 | Created adaptive routing PRD | AI assistant | `docs/PRD-adaptive-execution-model-routing.md` |
| 2026-05-05 | Added cache-efficiency requirements to PRD | AI assistant | Sticky per-run routing, deterministic prompts, deferred route memory. |
| 2026-05-05 | Created implementation status tracker | AI assistant | This file. |
| 2026-05-05 | Phase 1 landed: execution-routing types + config + validation + tests | AI assistant | `src/types.ts`, `src/config.ts`, `tests/config.test.ts`. 75/75 tests pass; lint clean. |
| 2026-05-05 | Phase 2 landed: Judge `executionRoute` schema + `coerceExecutionRoute` + `JudgeOutcome.route` | AI assistant | `src/actorJudge.ts`, `tests/actorJudge.test.ts`. 84/84 tests pass; lint clean. |
| 2026-05-05 | Phase 3 landed: pure `chooseExecutionModel` with preference, safety floors, pool fallback, allowlist | AI assistant | `src/executionRouter.ts`, `tests/executionRouter.test.ts`. 105/105 tests pass; lint clean. |
| 2026-05-05 | Addressed Phase 1 review fixes | AI assistant | Re-exported public types/defaults, deep-cloned loaded settings, removed unused variable, deferred/rejected `prefer`, updated tracker. |
| 2026-05-05 | Addressed Phase 2 review fixes | AI assistant | Froze `DEFAULT_EXECUTION_ROUTE`, added partially malformed route integration test, refreshed status notes. |

## 11. Definition of done

The PRD implementation is complete when:

- `[ ]` All MVP checklist items are complete.
- `[ ]` All functional acceptance criteria are satisfied.
- `[ ]` All cache-efficiency acceptance criteria are satisfied.
- `[ ]` All UX acceptance criteria are satisfied.
- `[ ]` Tests cover config, route parsing, model selection, router integration, and cache invariants.
- `[ ]` `npm test` passes.
- `[ ]` `npm run lint` passes.
- `[ ]` `npm run build` passes.
- `[ ]` README documents the new configuration and backwards-compatible default behavior.
- `[ ]` Any deferred decisions are explicitly marked `[d]` or moved to a follow-up PRD.
