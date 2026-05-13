# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Trace roadmap refocused** from harness self-evolution to trace observability for skill debugging. The original 5-phase auto-evolution loop (LLM proposer → benchmark validator → auto-apply) was killed after grill review: open-ended skills have no ground-truth signal to close the loop on. New direction is human-driven observability — deterministic trace classifier, degradation alerts, trace reports. PRD renamed to `docs/PRD-trace-observability.md`; in-source comments updated; new tracker in `docs/PRD-Implementation-Status.md` §12. No code behavior change.

## [1.4.0] — 2026-05-11

### Added

- **Execution trace store** for harness self-evolution — `ExecutionTraceStore` captures every tool call (server, tool, args, result preview, blocked flag, timestamp) during sub-agent execution and persists full traces as JSON to `.pi/traces/<skillName>_<timestamp>.json`. Enabled by default via `executionTrace` settings. See `docs/PRD-trace-observability.md` for the self-improvement roadmap.

- **`makeTraceMiddleware`** — a non-blocking observer middleware that records tool calls into an `ExecutionTraceStore` without affecting execution flow. Composed before the overflow middleware so raw payloads are captured pre-replacement.

- **TTL-based trace cleanup** (`cleanupTraces`) — automatically prunes trace files older than 7 days or exceeding a 500-file cap after each persist. Configurable via `TraceCleanupOptions`.

- **Skip-Judge mode** — setting `maxJudgeIterations: 0` now runs the Actor only (no Judge), produces a brief, and auto-passes. Useful for simple or well-known skills where verification overhead is unnecessary. Config validation floor lowered from 1 to 0.

- **Trace lifecycle wiring** — the router creates an `ExecutionTraceStore` before each execution, composes the trace middleware, and finalizes + persists the trace after sub-agent completion. Emits structured `auggie-router.execution-trace` log events with tool-call count and filepath.

- **Harness self-evolution PRD** (`docs/PRD-trace-observability.md`) — detailed 5-phase roadmap from trace collection to automatic SKILL.md improvement, inspired by Stanford/Tsinghua research on harness engineering. (Superseded post-1.4.0; see Unreleased.)

- New public exports: `ExecutionTraceStore`, `makeTraceMiddleware`, `ExecutionTrace`, `ExecutionTraceStoreSettings`, `ToolCallEntry`, `cleanupTraces`, `TraceCleanupOptions`.

- New config field: `executionTrace` in `RouterSettings` with `enabled`, `maxResultPreviewChars`, and `traceDirectory`.

### Changed

- **`AUGGIE_DIRECTIVE` slimmed** from 2 sentences to 1 (`"Use the \`codebase-retrieval\` MCP tool for workspace context."`). Drops the negative instruction — modern models don't need the hand-holding, and the subtraction reduces per-run token cost.

- **`renderBrief()` knownContext budget** — the free-form `knownContext` field from the Actor is now capped at 500 characters to prevent context bloat from cheap routing models.

- `ExecutionInput` in `subAgent.ts` accepts optional `traceStore` and `route` fields for trace capture.

- `JudgeOutcome.iterations` doc updated: 0 means Judge skipped, 1+ means full loop.

## [1.3.0] — 2026-05-11

### Added

- **Context-management controls** for cleaner long-running skill workflows:
  - `historyAssembly` with opt-in `headTail` assembly, explicit middle omission markers, and per-message/total character caps for Actor/Judge history.
  - `contextBudgets` with optional per-tier Auggie overflow ceilings (`cheap`, `balanced`, `frontier`) derived from the effective execution route.
  - `debugPromptPrefixHash`, an opt-in SHA-256/byte-count log for detecting prompt-cache regressions without logging prompt text.

- **Execution-scoped overflow context memory** — optional `contextMemory` support stores oversized Auggie `codebase-retrieval` payloads in a per-run temp store and returns compact overflow handles with bounded head/tail previews. When enabled, the sub-agent receives a companion `context-memory` MCP server exposing `context-memory.read` and `context-memory.list`; cleanup runs after execution.

- **Final-output sanitizer** — enabled by default via `outputSanitizer`. It strips clearly marked tool/MCP traces, preserves normal code fences, caps runaway final answers, and emits counts-only `auggie-router.output-sanitized` logs when it changes output.

- **Parallel sub-agent runner API** — `runParallelSubagents(...)` plus related public types. The feature is disabled by default and requires explicit subtasks; each worker gets isolated prompt/MCP/context-memory plumbing, capped output, bounded concurrency, and deterministic synthesis.

- **Long-session regression fixtures** covering 10+ and 20+ turn conversations, ambiguous Q&A, and large-history truncation behavior.

- New public exports: `assembleHistory`, `chooseContextBudget`, `EffectiveContextBudget`, `ContextMemoryStore`, `ContextMemoryEntry`, `ContextMemoryStoreResult`, `runParallelSubagents`, parallel worker/result types, `buildSubAgentSystemPrompt`, `sanitizeFinalText`, `SanitizeResult`, and new default setting constants for context budgets, context memory, history assembly, output sanitization, and parallel subagents.

### Changed

- README configuration and feature docs now cover output sanitization, context budgets, history assembly, prompt-prefix cache stability, and the updated execution flow.
- `DEFAULT_SETTINGS` now includes `outputSanitizer`, `contextBudgets`, `historyAssembly`, `contextMemory`, `parallelSubagents`, and `debugPromptPrefixHash` defaults. Existing runtime behavior remains backward compatible unless opt-in switches are enabled, except conservative final-output sanitization which is on by default.
- Sub-agent overflow handling can now receive an execution-scoped effective ceiling while preserving the legacy static `overflowCeilingBytes` path when context budgets are disabled.

### Fixed

- `package-lock.json` version metadata now matches the package version for the 1.3.0 release.

## [1.2.3] — 2026-05-10

### Fixed

- **Auggie pre-flight uses `auggie account status`** instead of the non-existent `auggie status` subcommand. The old spawn args caused every pre-flight to fail with a "command not found"–style error, blocking skill execution on installs that otherwise had a valid auggie session. Docs in `README.md` and `GETTING-STARTED.md` updated to match.

## [1.2.2] — 2026-05-07

### Changed

- **Extension bridge now uses Pi's `"input"` event** for `onUserInput` and `onBeforeMessage` instead of checking for non-existent methods. This eliminates the three startup warnings (`setInputLocked()`, `onUserInput`, `onBeforeMessage`) and makes the Q&A fallback flow fully functional when running as a pi extension.

### Changed

- **Updated package scope** from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` following the Pi project move to Earendil Works (`0.74.0+`). The old `@mariozechner/*` scope remains as an optional peer dependency for backwards compatibility.

## [1.2.1] — 2026-05-06

### Documentation

- **GETTING-STARTED.md** — document pi.dev extension-bridge limitations end-to-end:
  - Use `/skill <name>` (slash-command form), not `/skill:<name>`. The colon form is not interceptable through the bridge.
  - New "Bridge limitations" section enumerates the three startup warns (`setInputLocked` missing, `onUserInput` limited, `onBeforeMessage` unsupported), what each means in practice, and the workaround.
  - Q&A clarification troubleshooting now flags that under the bridge the typed reply is not captured — clarification path effectively dies, so re-run with a more specific input.
  - All sample commands updated from `/skill:<name>` to `/skill <name>`.
  - Added `pi update pi-auggie-router` instructions when `Unknown command: /skill` appears (older versions predate the `pi.extensions` manifest).

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
