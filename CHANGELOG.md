# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-05

### Added

- **Adaptive execution model routing** — opt-in feature that classifies each `/skill` invocation by complexity and risk, then selects an appropriate model from a configurable cheap/balanced/frontier pool. Disabled by default; existing behavior is preserved. ([PRD](docs/PRD-adaptive-execution-model-routing.md))

  New settings under `auggieRouter.executionRouting`:

  - `enabled` (default: `false`) — turn adaptive routing on.
  - `preference` (`"preferCheap"` | `"balanced"` | `"preferBest"`, default: `"balanced"`) — cost-vs-quality bias.
  - `surfaceDecision` (default: `false`) — show the selected tier/model in the `[System]` execution message.
  - `skillModelPolicy` (`"pin"` | `"ignore"`, default: `"pin"`) — how `SKILL.md` `model:` interacts with routing.
  - `models.cheap`, `models.balanced`, `models.frontier` — pool model IDs (all pass through `mapModel`).

- **Safety floors** — always enforced regardless of preference:
  - `architecture_change` → `frontier`
  - `multi_file_edit` → at least `balanced`
  - `unknown` risk + low confidence → at least `balanced`
  - Unpassed Judge → at least `balanced`

- **Missing pool fallback chains** — walks `cheap→balanced→frontier`, `balanced→frontier→cheap`, `frontier→balanced→cheap`; falls back to legacy `mapModel` when nothing resolves.

- **Structured route log** — every skill execution emits a JSON `auggie-router.execution-route` event via `host.log` with skill name, tier, model, source, complexity, risk, confidence, original and effective tiers.

- **Cache-efficiency invariant** — the selected execution model is computed once before `executeSkill()` and never changed during the sub-agent run. Route metadata is not injected into the sub-agent system prompt.

- **Judge `executionRoute` output** — the Actor/Judge loop now produces routing metadata (`tier`, `complexity`, `risk`, `confidence`, `reason`) alongside the rubric. Malformed or missing data falls back to `balanced/medium/unknown/0`.

- New public exports: `chooseExecutionModel`, `ChooseExecutionModelInput`, `ExecutionRouteSelection`, `DEFAULT_EXECUTION_ROUTE`, `coerceExecutionRoute`, `ExecutionRoute`, `ExecutionRoutingPreference`, `ExecutionRoutingSettings`, `ExecutionRoutingTier`, `SkillModelPolicy`, `DEFAULT_EXECUTION_ROUTING`.

### Changed

- Execution model resolution in `src/index.ts` now flows through `chooseExecutionModel()` instead of calling `mapModel()` directly. When `executionRouting.enabled` is `false`, the legacy path is used identically to before.

- README updated with full adaptive routing documentation, configuration tables, and updated execution flow.

## [1.0.1] — 2025-05-04

### Fixed

- Harden all security findings from deep review (path traversal, secret redaction, response size limits, message truncation, signal handling).
- `callWithTimeout` now uses `Promise.race` so a misbehaving host that ignores `AbortSignal` cannot block the router beyond the timeout.

## [1.0.0] — 2025-05-03

### Added

- Initial release: `/skill` sub-agent router with Actor/Judge brief loop, Augment Code MCP integration, overflow middleware, Q&A fallback, extension bridge, and configurable timeouts.
