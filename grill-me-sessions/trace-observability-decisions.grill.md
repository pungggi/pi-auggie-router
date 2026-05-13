# Grill Session: Trace Observability & Open Decisions

Started: 2026-05-11
Last updated: 2026-05-11
Status: complete
Domain: Software architecture / product design — interrogating open decisions blocking Phase 2+ of trace observability and deferred decisions from the adaptive routing PRD

## Summary

All 11 open decisions across the Trace Observability and Adaptive Routing PRDs have been resolved: 5 decided (with implementation implications), 5 deferred with explicit re-evaluation criteria, 1 confirmed as already implemented. Phase 2 (Trace Classifier + Structured Logging) now has clear requirements and no blocking decisions.

**Key decisions that change Phase 2 implementation:**
- Count-based retention (`maxTracesPerSkill`, default 20) replaces the current time-based TTL — requires rewriting `traceCleanup.ts`
- `classifyTrace` uses `confidence: number` (0..1), deterministic only
- Degradation alerts and trace reports live in the router
- Full on-demand reports use auto-threshold (inline ≤5 traces, file for larger) — requires new report rendering and file output logic

## Decision Log

### DECIDED: Degradation alerts placement
- **Decision**: Keep in the router, not a separate extension.
- **Rationale**: Router already owns trace collection, persist, and `host.postSystemMessage`. Adding classification + alerting after trace finalization is trivially composable. No need for new infrastructure, extension loaders, or lifecycle hooks. If alerting ever needs to expand beyond skill traces, it can be extracted then — but that's a hypothetical, not a current requirement.
- **Date**: 2026-05-11

### DECIDED: Default trace retention model
- **Decision**: Count-based retention (`maxTracesPerSkill`) instead of time-based TTL. Delete oldest traces per skill when count exceeds the limit. Default: 20.
- **Rationale**: The primary goal is "keep enough history for degradation detection to work." The detector needs N traces per skill, not N days of traces. Count-based retention auto-tunes to usage: light users' traces naturally live longer because they accumulate slowly; heavy users' traces get pruned more often but the regression window is always full. Eliminates the need for user self-classification (light/medium/heavy) or raw day-count tuning. The default (20) must exceed `regressionWindowSize` (10) so the detector always has enough signal.
- **Date**: 2026-05-11

### DECIDED: Default trace TTL (time-based)
- **Decision**: Superseded by count-based retention. No time-based TTL.
- **Rationale**: Count-based retention makes time-based TTL redundant for the detection goal. If disk usage becomes a concern later, a secondary max-age cap can be added — but not needed now.
- **Date**: 2026-05-11

### DECIDED: Route metadata in final output
- **Decision**: System message and logs only. Never in the assistant's final text.
- **Rationale**: Already implemented this way in v1.1.0+. Putting route metadata in the assistant output would feed it back into the `historyWindow` for future Actor/Judge loops — an active feedback loop that would contaminate routing decisions. The `[!]` marker in the status tracker should become `[x]`.
- **Date**: 2026-05-11

### DECIDED: classifyTrace LLM usage and type contract
- **Decision**: Deterministic only — no LLM, now or foreseeable future. Type uses `confidence: number` (0..1) as the natural float representation.
- **Rationale**: The `outcome` field does the heavy lifting for the degradation detector. `confidence` is human-facing metadata for reports. Whether the number comes from heuristics or an LLM doesn't change downstream behavior, so the type already supports future flexibility without ceremony. But the implementation decision is clear: deterministic heuristics only.
- **Date**: 2026-05-11

### DECIDED: Trace report surface and delivery
- **Decision**: Three surfaces, each matched to its consumer:
  1. **Degradation alerts** — always system message (inline, ephemeral, reactive)
  2. **Mini-report after execution** — always system message (short, last 3 traces, opt-in via `showReportAfterExecution`)
  3. **Full on-demand report** — auto-threshold: inline system message for ≤ `reportMaxInlineTraces` (default 5) traces; file output (markdown to `.pi/traces/reports/`) with a one-liner system message pointer for larger reports. Router decides based on size — zero new command syntax for the user.
- **Rationale**: Alerts and mini-reports are short and ephemeral by nature — system message is the only sensible channel. Full reports are reference material that can be 30+ lines for 20 traces; file output keeps the chat clean. The auto-threshold avoids forcing the user to pick a mode or remember a flag — quick checkups are inline, deep dives get a file.
- **Date**: 2026-05-11

### DEFERRED: Programmatic chooseExecutionModel override
- **Reason**: API for hosts/extensions to inject their own model selection logic. Zero consumers exist. Speculative API surface that adds config, validation, docs, and tests for nobody.
- **Re-evaluation criteria**: An external consumer (host, extension, or integration) requests programmatic model selection control.
- **Risk if ignored**: None — no one is asking for this.
- **Date**: 2026-05-11

### DEFERRED: Same-skill route memory
- **Reason**: Zero evidence that same-skill model churn is a real problem. Building memory before having evidence is the same pattern that killed the self-evolution PRD — solving a hypothetical. Additionally, route memory and the degradation detector have opposite incentives: memory locks a skill to one model, which could mask degradation that model variation would surface.
- **Re-evaluation criteria**: Phase 5 structured logs running for ≥ 2 weeks, AND tier distribution metric showing same-skill invocations bouncing between tiers ≥ 3 times in a session.
- **Risk if ignored**: Low — extra Judge evaluations per invocation are cheap (routing model cost). If churn proves real, this can be built in a later minor version.
- **Date**: 2026-05-11

### DEFERRED: Ask Pi host for token/cache metrics
- **Reason**: The `PiHost` interface doesn't expose token counts, cache stats, or cost data. Adding this requires either a new `host.getMetrics()` method (Pi host API change, not in our control), parsing provider response headers (fragile, provider-specific), or calling provider usage APIs separately (extra network, auth complexity). The trace observability pipeline provides proxy metrics (outcome verdicts, tool-call counts, duration, consecutive failures) that give 80% of the insight at 0% of the host API cost.
- **Re-evaluation criteria**: Pi's host API exposes usage/token data, OR cost attribution becomes a real user pain point.
- **Risk if ignored**: Low — trace classifier covers quality signals; cost visibility is a nice-to-have, not blocking any feature.
- **Date**: 2026-05-11

## Open Threads

1. ~~**classifyTrace LLM usage**~~ → **Decided: deterministic only, `confidence: number` (0..1)**
2. ~~**Trace report surface**~~ → **Decided: auto-threshold (inline ≤5, file for larger)**
3. ~~**Report delivery**~~ → **Merged into report surface decision**
4. ~~**Adaptive routing by default**~~ → **Deferred: no data until Phase 2 logs run**
5. ~~**Skill frontmatter minTier/maxTier**~~ → **Deferred: safety floors cover it, no demand**
6. ~~**Programmatic chooseExecutionModel override**~~ → **Deferred: zero consumers**
7. ~~**Route metadata in final output**~~ → **Decided: system message + logs only (already implemented)**
8. ~~**Same-skill route memory**~~ → **Deferred: no churn evidence, re-evaluate after Phase 5 logs**
9. ~~**Ask host for token/cache metrics**~~ → **Deferred: Pi host API doesn't expose it, trace classifier is sufficient proxy**

## Resolved Threads (moved to Decision Log)

- ~~Degradation alerts placement~~ → **Router**
- ~~Default trace TTL~~ → **Superseded by count-based retention (`maxTracesPerSkill`)**
- ~~classifyTrace LLM usage~~ → **Deterministic only, `confidence: number` (0..1)**
- ~~Route metadata in final output~~ → **System message + logs only (already implemented)**
- ~~Adaptive routing by default~~ → **Deferred: no data until Phase 2 logs run**
- ~~Skill frontmatter minTier/maxTier~~ → **Deferred: safety floors cover it, no demand**
- ~~Programmatic chooseExecutionModel override~~ → **Deferred: zero consumers**
- ~~Same-skill route memory~~ → **Deferred: no churn evidence, re-evaluate after Phase 5 logs**
- ~~Ask host for token/cache metrics~~ → **Deferred: Pi host API doesn't expose it, trace classifier is sufficient proxy**

## Parking Lot

None — all 11 threads resolved or deferred with criteria.
