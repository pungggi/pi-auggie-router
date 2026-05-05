# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-05-06

### Added

- **Native pi.dev extension entry** — package now ships `extension.ts` at root and declares `pi.extensions` in `package.json`. Install with a single command:
  ```bash
  pi install npm:pi-auggie-router
  ```
  No more manual `npm install` + `-e` flag or `.pi/extensions/` symlink. `pi install` reads the manifest and auto-registers the extension in pi settings (global by default, project-local with `-l`).

- **`/skill <name>` slash-command fallback** — registered alongside the `onUserInput` `/skill:` interceptor, so the router still works in pi.dev contexts where the bridge cannot hook the prefix directly. Skill names validated against `[a-zA-Z0-9_-]+`.

- **Optional peer dependency** on `@mariozechner/pi-coding-agent` (`>=0.70.6`). Marked optional so library consumers embedding `createRouter` in their own host are not forced to install it.

### Changed

- **GETTING-STARTED.md** rewritten for end-users running pi.dev terminal. Drops host-mounting code; flow is now: `pi install` → write `SKILL.md` → run `/skill:<name>`.

## [1.1.0] — 2026-05-05

### Added

- **Adaptive execution model routing** — opt-in feature that classifies each `/skill` invocation by complexity and risk, then selects an appropriate model from a configurable cheap/balanced/frontier pool. Disabled by default; existing behavior is preserved. See the README for configuration and behavior details.

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

- Provider allowlists now apply to the final resolved model provider for every `mapModel()` path, including defaultProvider-prefixed vendor/bare models and fallback defaults.

- Extension bridge child-process handling now uses private temp directories/files, caps captured stdout/stderr, and redacts secrets in child-process stderr before including it in errors.

- Execution model resolution in `src/index.ts` now flows through `chooseExecutionModel()` instead of calling `mapModel()` directly. When `executionRouting.enabled` is `false`, the legacy path is used identically to before.

- README updated with full adaptive routing documentation, configuration tables, and updated execution flow.

## [1.0.1] — 2025-05-04

### Fixed

- Harden all security findings from deep review (path traversal, secret redaction, response size limits, message truncation, signal handling).
- `callWithTimeout` now uses `Promise.race` so a misbehaving host that ignores `AbortSignal` cannot block the router beyond the timeout.

## [1.0.0] — 2025-05-03

### Added

- Initial release: `/skill` sub-agent router with Actor/Judge brief loop, Augment Code MCP integration, overflow middleware, Q&A fallback, extension bridge, and configurable timeouts.
