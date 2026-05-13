# PRD Implementation Status: Adaptive Execution Model Routing

**Source PRD:** [`docs/PRD-adaptive-execution-model-routing.md`](./PRD-adaptive-execution-model-routing.md)  
**Package:** `pi-auggie-router`  
**Status owner:** TBD  
**Last updated:** 2026-05-11
**Overall status:** Adaptive execution routing MVP complete and shipped in the 1.x line. v1.3.0 adds the separate context-management MVPs tracked in [`docs/context-management-action-plans.md`](./context-management-action-plans.md). Phase 6 (same-skill route memory) remains deferred.

---

Also tracks: **Trace Observability for Skill Debugging** ([`docs/PRD-trace-observability.md`](./PRD-trace-observability.md)) — replaces the former self-evolution PRD. Status: Phase 1 complete (trace store shipped in v1.4.0); Phase 2 not started. See [Section 12](#12-trace-observability-status).

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
| 4 | Cache-safe router wiring | `[x]` | `chooseExecutionModel` wired into `src/index.ts`; one model per run; no prompt mutation. |
| 5 | Observability | `[x]` | Structured route logs via `host.log`; optional `surfaceDecision` system message. |
| 6 | Optional cache-aware route memory | `[d]` | Deferred until logs prove same-skill model churn matters. |
| 7 | README/docs update | `[x]` | README updated with adaptive routing section, config, policies, safety floors, observability. |
| 8 | Release readiness | `[x]` | Released as v1.1.0; package is now at v1.3.0 with later context-management/docs cleanup. CHANGELOG, lint/build/test, exports all confirmed. |

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
- `[x]` Export `ChooseExecutionModelInput` for public wrapper/helper typing.
- `[x]` Document that `tier="balanced"` is only a neutral sentinel for `skill-model`/`fallback` sources; UI must branch on `source` before displaying tier.
- `[x]` Defensively treat unsupported runtime `skillModelPolicy` values as `ignore` for JS callers bypassing config validation.

Files likely touched:

- `src/executionRouter.ts`
- `src/index.ts` exports, if needed
- `tests/executionRouter.test.ts`

### Phase 4 — Cache-safe router wiring

Goal: replace static model resolution with adaptive selection while preserving cache efficiency.

Tasks:

- `[x]` Replace direct model resolution in `src/index.ts` with `chooseExecutionModel(...)`.
- `[x]` Compute the selected model exactly once before `executeSkill(...)`.
- `[x]` Pass selected model unchanged as `resolvedModel`.
- `[x]` Ensure no mid-run, per-tool-call, MCP-tool-result, or sub-agent-follow-up re-routing exists.
- `[x]` Do not add route metadata to `systemPrompt` in `src/subAgent.ts`.
- `[x]` Do not add route metadata to `userPrompt` unless explicitly accepted later; MVP should keep prompts unchanged except existing brief rendering.
- `[x]` Keep `systemPrompt` deterministic:
  - `skill.instructions`
  - `AUGGIE_DIRECTIVE`
  - optional host appendix
- `[x]` Preserve existing behavior when routing is disabled.
- `[x]` Apply safety floor: enforce `minimumTier="balanced"` when Judge did not pass so `preferCheap` cannot downgrade the selected model.

Files touched:

- `src/index.ts`

### Phase 5 — Observability

Goal: make routing decisions debuggable without exposing prompt content or hurting cacheability.

Tasks:

- `[x]` Add optional host-visible route decision when `executionRouting.surfaceDecision=true`.
- `[x]` Preserve current minimal execution message when `surfaceDecision=false`.
- `[x]` Emit structured local log through `host.log?.("info", ...)` using the effective route used for model selection:

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

- `[x]` Do not log raw user prompt content.
- `[x]` Do not log raw chat history.
- `[x]` Do not log secrets or file-system paths beyond existing safe behavior.
- `[x]` Surface decisions for routed, pinned SKILL.md, and fallback/default model sources without misusing the neutral `tier="balanced"` sentinel.
- `[x]` Sanitize surfaced decision reasons to one line before posting system messages.

Files touched:

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

- `[x]` Update README configuration example with `executionRouting`.
- `[x]` Document defaults.
- `[x]` Document `skillModelPolicy`.
- `[x]` Document cache-efficiency invariant: one selected model per `/skill` run.
- `[x]` Document `surfaceDecision` behavior.
- `[x]` Document provider allowlist enforcement for pool models.
- `[x]` Add migration note: disabled by default, existing behavior preserved.

Files touched:

- `README.md`
- `docs/PRD-Implementation-Status.md`

### Phase 8 — Release readiness

Tasks:

- `[x]` Run `npm test`.
- `[x]` Run `npm run lint`.
- `[x]` Run `npm run build`.
- `[d]` Confirm generated `dist/` output is updated if this package tracks build artifacts. *(Not tracked: `dist/` is gitignored and generated by `prepublishOnly`.)*
- `[x]` Confirm package exports include any new public helpers/types intended for consumers.
- `[x]` Prepare release notes.
- `[x]` Decide semver bump: **minor** (1.1.0) — new config surface, backwards-compatible, disabled by default.

## 4. Acceptance criteria tracker

### Functional

- `[x]` With `executionRouting.enabled=false`, existing behavior and tests remain unchanged.
- `[x]` With `executionRouting.enabled=true` and no `SKILL.md model:`, the router chooses from configured tier models.
- `[x]` With `skillModelPolicy="pin"` and `SKILL.md model:` present, the router uses the skill model exactly as before.
- `[x]` With `skillModelPolicy="ignore"`, the router ignores `SKILL.md model:` and chooses from the pool.
- `[x]` Selected route remains fixed for the entire sub-agent run.
- `[x]` The router does not re-route on MCP tool results or sub-agent follow-up calls.
- `[x]` Invalid/missing route metadata falls back safely to `balanced`.
- `[x]` `allowedProviderPrefixes` applies to all configured pool models.

### Cache efficiency

- `[x]` The selected execution model is computed once before `executeSkill(...)`.
- `[x]` The selected execution model is passed unchanged to `host.runSubAgent(...)`.
- `[x]` Route tier/model/reason is not injected into the sub-agent system prompt.
- `[x]` System prompt construction remains deterministic for the same skill instructions, Auggie directive, and host appendix.
- `[x]` Host-visible route messages and structured logs can include tier/model/reason without changing sub-agent prompt text.

### UX

- `[x]` When `surfaceDecision=false`, the user-visible execution message remains current/minimal.
- `[x]` When `surfaceDecision=true`, the message includes selected tier and resolved model.
- `[x]` User-facing errors do not leak filesystem paths or secrets.

## 5. Test tracker

Add or extend tests for:

- `[x]` Config defaults.
- `[x]` Config validation for nested execution-routing values.
- `[x]` Route parsing/coercion.
- `[x]` Malformed route metadata fallback.
- `[x]` Missing route metadata fallback.
- `[x]` Preference adjustment.
- `[x]` Safety floors.
- `[x]` Missing model-tier fallback for all PRD chains (`cheap→balanced→frontier`, `balanced→frontier→cheap`, `frontier→balanced→cheap`).
- `[x]` `skillModelPolicy="pin"`.
- `[x]` `skillModelPolicy="ignore"`.
- `[d]` `skillModelPolicy="prefer"` policy behavior; deferred beyond MVP.
- `[x]` `skillModelPolicy="prefer"` is rejected by config validation until implemented.
- `[x]` Provider allowlist enforcement on pool models.
- `[x]` Router integration message when `surfaceDecision=true`.
- `[x]` Router integration message remains minimal when `surfaceDecision=false`.
- `[x]` Cache-safety invariant: one resolved execution model per sub-agent run.
- `[x]` Prompt determinism: route metadata does not change `systemPrompt` passed to `runSubAgent(...)`.
- `[x]` Existing router tests pass unchanged when routing is disabled.

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

- Execution model resolution now flows through `chooseExecutionModel(...)`.
- With `executionRouting.enabled=false`, `chooseExecutionModel(...)` preserves legacy `mapModel(skill.rawModel, ...)` behavior.
- Actor/Judge returns `brief`, `rubric`, `passed`, `iterations`, and an always-populated `route`.
- Adaptive execution routing is wired into `src/index.ts`; one selected model is computed before `executeSkill(...)` and passed unchanged.
- Cache-efficiency requirements are enforced by router tests: route metadata is not injected into sub-agent prompts and model selection is sticky per run.

Relevant current files:

- `src/actorJudge.ts`
- `src/config.ts`
- `src/index.ts`
- `src/executionRouter.ts`
- `src/modelMapper.ts`
- `src/subAgent.ts`
- `src/types.ts`
- `tests/actorJudge.test.ts`
- `tests/config.test.ts`
- `tests/executionRouter.test.ts`
- `tests/modelMapper.test.ts`
- `tests/router.test.ts`
- `CHANGELOG.md`

## 10. Progress log

| Date | Change | Author | Notes |
| --- | --- | --- | --- |
| 2026-05-05 | Created adaptive routing PRD | AI assistant | `docs/PRD-adaptive-execution-model-routing.md` |
| 2026-05-05 | Added cache-efficiency requirements to PRD | AI assistant | Sticky per-run routing, deterministic prompts, deferred route memory. |
| 2026-05-05 | Created implementation status tracker | AI assistant | This file. |
| 2026-05-05 | Phase 1 landed: execution-routing types + config + validation + tests | AI assistant | `src/types.ts`, `src/config.ts`, `tests/config.test.ts`. 75/75 tests pass; lint clean. |
| 2026-05-05 | Phase 2 landed: Judge `executionRoute` schema + `coerceExecutionRoute` + `JudgeOutcome.route` | AI assistant | `src/actorJudge.ts`, `tests/actorJudge.test.ts`. 84/84 tests pass; lint clean. |
| 2026-05-05 | Phase 3 landed: pure `chooseExecutionModel` with preference, safety floors, pool fallback, allowlist | AI assistant | `src/executionRouter.ts`, `tests/executionRouter.test.ts`. 105/105 tests pass; lint clean. |
| 2026-05-05 | Addressed Phase 3 review fixes | AI assistant | Exported input type, covered all fallback chains, clarified tier sentinel UX, defensive unsupported policy handling. |
| 2026-05-05 | Addressed Phase 1 review fixes | AI assistant | Re-exported public types/defaults, deep-cloned loaded settings, removed unused variable, deferred/rejected `prefer`, updated tracker. |
| 2026-05-05 | Addressed Phase 2 review fixes | AI assistant | Froze `DEFAULT_EXECUTION_ROUTE`, added partially malformed route integration test, refreshed status notes. |
| 2026-05-05 | Phase 4 landed: cache-safe router wiring | AI assistant | `src/index.ts` uses `chooseExecutionModel` once per run; safety floor for unpassed judge; 117/117 tests pass. |
| 2026-05-05 | Phase 5 landed: observability | AI assistant | Structured route logs via `host.log`; optional `surfaceDecision` system message; prompt cache preserved. |
| 2026-05-05 | Addressed Phase 4/5 review fixes | AI assistant | Added `minimumTier`, extracted route/message/log helpers, used effective route consistently, sanitized/surfaced all decision sources. |
| 2026-05-05 | Phase 7 landed: README/docs update | AI assistant | Added adaptive routing section, config table, preference/safety/policy docs, execution flow update, migration note. |
| 2026-05-05 | Addressed Phase 7 review fixes | AI assistant | Reduced duplicate config, clarified surfaceDecision/fallback/minimum-tier behavior, refreshed implementation notes and dist policy. |
| 2026-05-05 | Phase 8: release readiness | AI assistant | v1.1.0 minor bump. CHANGELOG.md created. All acceptance criteria met. |
| 2026-05-11 | v1.3.0 docs/status cleanup | AI assistant | Added 1.3.0 changelog entry, refreshed context-management plan status, and clarified this PRD status is historical for adaptive routing. |
| 2026-05-05 | Addressed Phase 8 review fixes | AI assistant | Updated package-lock version, removed broken packaged PRD link, completed DoD checklist, refreshed relevant files. |
| 2026-05-05 | Security hardening review fixes | AI assistant | Enforced provider allowlist on final mapped models; hardened extension bridge temp files/stdout/stderr; added capped output helper/tests. |

## 11. Definition of done

The PRD implementation is complete when:

- `[x]` All MVP checklist items are complete.
- `[x]` All functional acceptance criteria are satisfied.
- `[x]` All cache-efficiency acceptance criteria are satisfied.
- `[x]` All UX acceptance criteria are satisfied.
- `[x]` Tests cover config, route parsing, model selection, router integration, and cache invariants.
- `[x]` `npm test` passes.
- `[x]` `npm run lint` passes.
- `[x]` `npm run build` passes.
- `[x]` README documents the new configuration and backwards-compatible default behavior.
- `[x]` Any deferred decisions are explicitly marked `[d]` or moved to a follow-up PRD.

---

## 12. Trace Observability Status

**Source PRD:** [`docs/PRD-trace-observability.md`](./PRD-trace-observability.md) (rewritten from former "Harness Self-Evolution via Execution Traces" PRD)
**Last updated:** 2026-05-11

### Background

The original PRD proposed a 5-phase self-evolution loop (LLM proposer → benchmark validator → auto-apply) inspired by the Tsinghua/DSPy research. After interrogation (see [`../grill-me-sessions/self-evolution.grill.md`](../grill-me-sessions/self-evolution.grill.md)), we determined the core mechanism requires objective ground-truth scoring that does not exist in auggie-router's open-ended, one-shot execution environment. The PRD was excitement-driven, not pain-driven.

The PRD was rewritten to focus on **lightweight trace observability** — making traces legible to humans rather than automating instruction rewrites.

### Milestone overview

| Phase | Name | Status | Notes |
| --- | --- | --- | --- |
| 1 | Trace Collection | `[x]` | `ExecutionTraceStore` shipped in v1.4.0 |
| 2 | Trace Classifier + Structured Logging | `[x]` | `classifyTrace()` with deterministic heuristics; `detectRegression()` for consecutive failure escalation; count-based cleanup; `TraceObservabilitySettings` config |
| 3 | Degradation Alerts | `[x]` | `checkDegradationAlert()` with consecutive failure counting, cooldown tracking, signal aggregation, system message formatting; wired into index.ts |
| 4 | Trace Report Command | `[x]` | `/skill:trace-report <name>` command; `renderTraceReport()` with outcome distribution, signal aggregation, trend line, recent traces; `renderMiniReport()` for auto after-execution; wired into index.ts input hook |
| 5 | Single-Trace Viewer | `[x]` | `/skill:trace-view <filename>` for deep debugging; tool-call timeline with args preview, result sizes, duration, signals |

### Phase 1 — Trace Collection `[x]`

- `[x]` `ExecutionTraceStore` persists traces to `.pi/traces/<skillName>_<timestamp>.json`
- `[x]` `makeTraceMiddleware` records tool calls non-blockingly
- `[x]` `ExecutionTraceSettings` in config and types
- `[x]` `executeSkill` accepts optional `traceStore` input

### Phase 2 — Trace Classifier + Structured Logging `[x]`

- `[x]` Define `TraceVerdict` type and `classifyTrace()` function
- `[x]` Implement heuristic classification signals (timeout, inactivity, abort, empty output, error markers, high tool-call count, low confidence)
- `[x]` Emit `trace-classified` structured log after each execution
- `[x]` Rewrite trace cleanup from TTL-based to count-based per-skill retention (`maxTracesPerSkill`, default 20)
- `[x]` Add `detectRegression()` — upgrades `likely-failure` to `likely-regression` when ≥3 consecutive failures after prior success
- `[x]` Define `TraceObservabilitySettings` in types and config with full validation
- `[x]` Wire classifier into trace persistence flow in `index.ts`

### Phase 3 — Degradation Alerts `[x]`

- `[x]` Track consecutive failure count per skill from classified traces
- `[x]` Emit degradation alert system message when ≥ N consecutive failures
- `[x]` Rate-limit alerts (cooldown per skill, default 24h)
- `[x]` Only alert if skill has at least one historical success (no false alerts on skills that never worked)
- `[x]` Aggregate signal counts across consecutive failures in alert message
- `[x]` Show last successful run timestamp in alert message
- `[x]` `resetAlertCooldowns()` exported for testing
- `[x]` In-memory cooldown state (resets on router restart, acceptable for "don't nag" guard)

### Phase 4 — Trace Report Command `[x]`

- `[x]` Implement `/skill:trace-report <name>` command surface (intercepted before `/skill:` handler)
- `[x]` Load last N traces, classify, render summary with success rates and common signals
- `[x]` Include trend line (success rate over recent runs)
- `[x]` List recent traces with verdicts, tool-call counts, and durations
- `[x]` Auto mini-report after execution when `showReportAfterExecution` is enabled
- `[x]` Outcome distribution with ASCII bar chart
- `[x]` Signal aggregation (most common failure signals with counts)
- `[x]` `loadAndClassifyTraces()` helper for loading + classifying in one call

### Phase 5 — Single-Trace Viewer `[x]`

- `[x]` Implement `/skill:trace-view <filename>` command surface
- `[x]` Add `ExecutionTraceStore.loadSingleTrace()` static method with path-traversal protection
- `[x]` Render tool-call timeline with timestamps, args summaries, result preview sizes
- `[x]` Show metadata header (model, route, confidence, risk, duration, tool-call count)
- `[x]` Show classification verdict with signals
- `[x]` Show final text (truncated for inline display)
- `[x]` Timeline truncation for large tool-call counts (first/last split with ellipsis)
- `[x]` Stopped-reason annotation (timeout/inactivity/abort emojis)
- `[x]` 30 new tests (viewer rendering, timeline truncation, args preview, duration, loadSingleTrace, path-traversal prevention)

### Open decisions

| Decision | Status | Resolution |
| --- | --- | --- |
| How to surface the trace report? | `[x]` | Auto-threshold: inline ≤5 traces, file for larger |
| Should `classifyTrace` ever use an LLM? | `[x]` | No — deterministic only, `confidence: number` (0..1) |
| Degradation alerts in router or separate extension? | `[x]` | Router |
| Default trace TTL? | `[x]` | Superseded by count-based `maxTracesPerSkill` (default 20) |
| Report inline or to file? | `[x]` | Auto-threshold (merged with report surface decision) |

### Progress log

| Date | Change | Author | Notes |
| --- | --- | --- | --- |
| 2026-05-11 | Original self-evolution PRD created | AI assistant | 5-phase propose/validate/auto-apply loop |
| 2026-05-11 | Self-evolution PRD grilled and killed | Grill session | Phases 3-5 eliminated; domain mismatch with Tsinghua research (no ground truth) |
| 2026-05-11 | PRD rewritten as Trace Observability | AI assistant | `docs/PRD-harness-self-evolution.md` rewritten and renamed to `docs/PRD-trace-observability.md` |
| 2026-05-11 | Implementation status tracker added | AI assistant | This section |
| 2026-05-11 | Phase 2 implemented | AI assistant | `classifyTrace()`, `detectRegression()`, count-based cleanup, `TraceObservabilitySettings` config, 248 tests passing |
| 2026-05-11 | Phase 3 implemented | AI assistant | `checkDegradationAlert()`, signal aggregation, cooldown tracking, alert formatting, wired into index.ts, 261 tests passing |
| 2026-05-11 | Phase 4 implemented | AI assistant | `/skill:trace-report <name>`, `renderTraceReport()`, `renderMiniReport()`, trend line, signal aggregation, auto mini-report, 273 tests passing |
| 2026-05-11 | Code review fixes (9 issues) | AI assistant | Fixed dead `maxInlineTraces`, per-instance cooldown tracker, cached verdicts, shared `extractSignalPrefix`, documented divergences; 283 tests passing |
| 2026-05-11 | Phase 5 implemented | AI assistant | `/skill:trace-view <filename>`, `renderTraceView()`, `loadSingleTrace()`, tool-call timeline, args preview, timeline truncation, path-traversal protection; 313 tests passing |
