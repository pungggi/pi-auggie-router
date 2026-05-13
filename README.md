# pi-auggie-router

> Opinionated `/skill:` sub-agent router for the Pi framework.
> Tightly couples Anthropic-style `SKILL.md` execution with the
> Augment Code (`auggie`) Context Engine via MCP.

**New to pi-auggie-router?** Start with the [Getting Started guide](GETTING-STARTED.md) for a step-by-step walkthrough of your first skill workflow.

`pi-auggie-router` intercepts `/skill:<name>` commands inside a Pi host,
parses the matching `SKILL.md`, runs a 2-pass **Actor/Judge** brief loop
against a cheap routing model, then dispatches the work to an isolated Pi
sub-agent that is forced to retrieve workspace context through Augment Code's
`codebase-retrieval` MCP tool. The main thread stays clean — the user sees
their command and the synthesized result, nothing else.

## Why

Out of the box, `/skill` execution dumps full file blobs into context, blows
out token budgets, and produces inconsistent retrieval. This router takes the
opposite stance: a single hardcoded path through Augment's semantic engine,
strict timeouts, and a payload ceiling that forces the model to refine its
own queries instead of vomiting megabytes back into the loop.

This package is **vendor-locked on purpose**. It will not run without a
working local `auggie` install.

## Installation

```bash
npm install pi-auggie-router
```

Requires Node ≥ 20.6 and a working [Augment Code CLI](https://www.augmentcode.com/)
(`auggie account status` must exit 0).

## Mounting it inside a Pi host

```ts
import { createRouter } from "pi-auggie-router";

const router = createRouter(piHost);

// Later, on shutdown:
router.dispose();
```

`piHost` must satisfy the `PiHost` contract exported from this package:

| Method                  | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `postSystemMessage`     | Append `[System]: …` lines to the visible thread.                       |
| `postAssistantMessage`  | Append the sub-agent's final synthesized output to the thread.          |
| `setInputLocked`        | Disable / re-enable the user's main editor while a skill runs.          |
| `getRecentMessages(n)`  | Return the last `n` chat messages for Actor brief assembly.             |
| `callLLM(opts)`         | Cheap routing-class call used by Actor + Judge.                         |
| `runSubAgent(opts)`     | Spin up an isolated Pi agent with MCP servers + middleware attached.    |
| `onUserInput(cb)`       | Invoked for every user input; return `{cancel:true}` to swallow.        |
| `onBeforeMessage(cb)`   | Invoked before a typed message is sent; used for the Q&A fallback.      |
| `resolveWorkspacePath`  | Resolve paths inside the active workspace (for `.pi/skills/...`).       |
| `resolveHomePath`       | Resolve paths inside `~` (for `~/.pi/agent/skills/...`).                |
| `log` (optional)        | Structured logger.                                                      |

## Configuration

All knobs live under `auggieRouter` in `.pi/settings.json`:

```json
{
  "auggieRouter": {
    "defaultProvider": "openrouter",
    "routingModel": "anthropic/claude-3-5-haiku",
    "historyWindow": 20,
    "maxJudgeIterations": 2,
    "routingTimeoutMs": 60000,
    "qaTimeoutMs": 300000,
    "totalTimeoutMs": 300000,
    "inactivityTimeoutMs": 60000,
    "subAgentTemperature": 0.0,
    "overflowCeilingBytes": 25000,
    "auggieBinPath": "auggie",
    "allowedProviderPrefixes": [],
    "executionRouting": {
      "enabled": false,
      "preference": "balanced",
      "surfaceDecision": false,
      "skillModelPolicy": "pin",
      "models": {
        "cheap": "anthropic/claude-3-5-haiku",
        "balanced": "anthropic/claude-3-5-sonnet",
        "frontier": "anthropic/claude-3-7-sonnet"
      }
    },
    "debugPromptPrefixHash": false,
    "outputSanitizer": {
      "enabled": true,
      "finalOutputMaxChars": 120000,
      "stripToolTraces": true
    },
    "contextBudgets": {
      "enabled": false,
      "overflowCeilingBytes": {
        "cheap": 15000,
        "balanced": 25000,
        "frontier": 50000
      }
    },
    "historyAssembly": {
      "strategy": "recent",
      "headMessages": 2,
      "tailMessages": 12,
      "middleMode": "marker",
      "maxCharsPerMessage": 10000,
      "maxTotalChars": 60000
    },
    "contextMemory": {
      "enabled": false,
      "maxEntries": 8,
      "maxBytesPerRun": 1000000,
      "previewHeadChars": 4000,
      "previewTailChars": 4000
    },
    "parallelSubagents": {
      "enabled": false,
      "maxSubagents": 3,
      "perWorkerOutputCharCap": 8000
    },
    "executionTrace": {
      "enabled": true,
      "maxResultPreviewChars": 2000,
      "traceDirectory": ".pi/traces"
    },
    "traceObservability": {
      "enabled": true,
      "showReportAfterExecution": false,
      "degradationAlertEnabled": true,
      "degradationConsecutiveFailures": 3,
      "degradationAlertCooldownHours": 24,
      "reportMaxTraces": 10,
      "reportMaxInlineTraces": 5,
      "regressionWindowSize": 10,
      "maxTracesPerSkill": 20
    }
  }
}
```

> **Note on data exposure:** the routing-class model (default
> `claude-3-5-haiku` via OpenRouter) sees the last `historyWindow` chat
> messages. If your chat may contain secrets, point `routingModel` at a
> self-hosted gateway or trim `historyWindow`.

Defaults match the values shown above. Only `defaultProvider` is expected to
change in normal use; everything else is opinionated for a reason.

## Adaptive Execution Model Routing

By default, the router resolves the execution model from the `SKILL.md`
`model:` frontmatter field (or a built-in fallback). This means easy tasks
and hard tasks run on the same static model.

Adaptive execution routing adds a lightweight model-selection step: after the
Actor/Judge loop classifies the task by complexity and risk, the router picks
an appropriate model from a configurable **cheap / balanced / frontier** pool.
The selection is **sticky** for the entire `/skill` run — one model is chosen
before the sub-agent starts and never changes mid-execution.

**Disabled by default.** Existing behavior is preserved unless you explicitly
opt in.

### Enabling adaptive routing

The smallest opt-in is:

```json
{
  "auggieRouter": {
    "executionRouting": {
      "enabled": true,
      "surfaceDecision": true
    }
  }
}
```

Omitted fields use the defaults shown in the main configuration block above.

### How it works

1. The Judge (already running in the Actor/Judge loop) classifies the task
   with an `executionRoute` that includes `tier`, `complexity`, `risk`,
   `confidence`, and a `reason`.
2. The router applies a **preference adjustment** (see below) and **safety
   floors** — e.g. `architecture_change` tasks always use `frontier`.
3. Exactly one model is selected from the configured pool and passed to the
   sub-agent. No mid-run re-routing occurs.
4. Route metadata is **never injected into the sub-agent system prompt**,
   preserving prompt-cache efficiency.

### Settings

| Setting | Values | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | `true` / `false` | `false` | Turn adaptive routing on. |
| `preference` | `preferCheap` / `balanced` / `preferBest` | `balanced` | Cost-vs-quality bias. |
| `surfaceDecision` | `true` / `false` | `false` | Show the selected model in the `[System]` execution message. Routed decisions include tier; pinned/fallback decisions name their source. |
| `skillModelPolicy` | `pin` / `ignore` | `pin` | How `SKILL.md` `model:` interacts with routing. |
| `models.cheap` | model ID | `anthropic/claude-3-5-haiku` | Model for read-only / low-complexity tasks. |
| `models.balanced` | model ID | `anthropic/claude-3-5-sonnet` | Model for scoped edits and medium-complexity tasks. |
| `models.frontier` | model ID | `anthropic/claude-3-7-sonnet` | Model for multi-file / architecture / high-risk tasks. |

All configured model IDs pass through `mapModel(...)` so `defaultProvider`
and `allowedProviderPrefixes` continue to apply.

### Preference adjustment

| Preference | Behavior |
| --- | --- |
| `balanced` | Use the base tier chosen by the Judge. |
| `preferCheap` | Downgrade `balanced` → `cheap` when complexity is `medium`, risk is `read_only` or `small_edit`, and confidence ≥ 0.7. Never downgrades high-risk tasks. |
| `preferBest` | Upgrade cheap edit tasks to `balanced`. Upgrade unknown-risk tasks to `frontier`. |

### Safety floors (always enforced)

Regardless of preference:

- `architecture_change` always routes to `frontier`.
- `multi_file_edit` never routes below `balanced`.
- `unknown` risk with confidence < 0.5 never routes below `balanced`.
- If the Judge did not pass (Q&A was needed), the minimum tier is `balanced`.

### Skill model policy

| Policy | Behavior |
| --- | --- |
| `pin` | If `SKILL.md` has `model:`, use it exactly as before. Only tasks without a pinned model go through adaptive routing. **Safest default.** |
| `ignore` | Ignore `SKILL.md` `model:` and always route from the pool. Useful for team-level cost control. |

### Missing pool entries

If the selected tier has no model configured, the router walks a fallback chain:

- Missing `cheap` → `balanced` → `frontier`
- Missing `balanced` → `frontier` → `cheap`
- Missing `frontier` → `balanced` → `cheap`

If nothing in the pool resolves, the router falls back to legacy model
resolution so the skill still runs. When no minimum tier is active, this may
use `SKILL.md model:` through `mapModel(skill.rawModel, ...)`. When the Judge
did not pass and the minimum tier is `balanced`, fallback uses the default
balanced model instead of a potentially cheaper pinned model.

### Observability

When `surfaceDecision=true`, the execution message includes the selected model.
For routed decisions it includes the tier; for pinned or fallback decisions it
names the source instead of showing the neutral `balanced` sentinel:

```
[System]: ⚙️ Executing /skill:refactor using balanced model openrouter/anthropic/claude-3-5-sonnet. Reason: route balanced (complexity=medium, risk=small_edit, confidence=0.82)
[System]: ⚙️ Executing /skill:refactor using SKILL.md model openrouter/anthropic/claude-3-7-sonnet. Reason: skillModelPolicy=pin; SKILL.md model honoured.
[System]: ⚙️ Executing /skill:refactor using fallback model openrouter/anthropic/claude-3-5-sonnet. Reason: Execution-routing pool unavailable; used legacy default model resolution.
```

When `surfaceDecision=false` (default), the existing minimal message is shown:

```
[System]: ⚙️ Executing /skill:refactor (Auggie semantic retrieval running...)
```

Every skill execution emits a structured log via `host.log`:

```json
{
  "event": "auggie-router.execution-route",
  "skill": "refactor",
  "tier": "balanced",
  "model": "openrouter/anthropic/claude-3-5-sonnet",
  "source": "execution-routing",
  "complexity": "medium",
  "risk": "small_edit",
  "confidence": 0.82,
  "routeTier": "balanced",
  "effectiveTier": "balanced"
}
```

No user prompt content, chat history, or secrets are logged.

### Security-relevant settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `auggieBinPath` | `"auggie"` | Absolute path to the `auggie` binary. Override to avoid `$PATH` lookup attacks in shared environments. |
| `allowedProviderPrefixes` | `[]` (allow all) | Non-empty array restricts which provider prefixes a SKILL `model:` field may resolve to. E.g. `["openrouter"]` blocks `evil-provider/vendor/model`. |

All numeric settings are validated within safe ranges; invalid values are silently
dropped and a warning is logged. See source (`config.ts`) for exact bounds.

### Skill `model:` translation

The `model:` field in a skill's frontmatter is translated through
`mapModel(rawModel, defaultProvider, allowedProviderPrefixes)`:

| Frontmatter `model`                       | Resolved gateway ID                                |
| ----------------------------------------- | -------------------------------------------------- |
| `claude-3-7-sonnet`                       | `openrouter/anthropic/claude-3-7-sonnet`           |
| `anthropic/claude-3-5-haiku`              | `openrouter/anthropic/claude-3-5-haiku`            |
| `openrouter/anthropic/claude-3-5-sonnet`  | _(unchanged — already fully qualified)_            |
| _(missing)_                               | `openrouter/anthropic/claude-3-5-sonnet` (fallback)|

When `allowedProviderPrefixes` is set (e.g. `["openrouter"]`), a fully-qualified
model whose provider prefix isn't in the list throws `DisallowedProviderError` and
execution is aborted. This prevents a malicious SKILL.md from routing requests
to an untrusted provider.

## Final-output sanitization

The router sanitizes the sub-agent's final text before posting it to the main
thread. This keeps internal tool traces, MCP envelopes, and runaway retrieval
dumps out of the user's chat history — which also keeps future `historyWindow`
slices clean.

| Setting | Default | Purpose |
| --- | --- | --- |
| `outputSanitizer.enabled` | `true` | Master switch. When `false`, sub-agent output passes through unchanged. |
| `outputSanitizer.finalOutputMaxChars` | `120000` | Hard cap on final answer characters. The truncation marker counts against the budget. Set to `0` to disable the cap. |
| `outputSanitizer.stripToolTraces` | `true` | Remove fenced blocks labeled `tool_use`, `tool_result`, `mcp`, `codebase-retrieval`, `auggie`, `scratchpad`, `internal` (and `-`/`_` variants), plus bare `{"jsonrpc":...}` / `{"tool_use_id":...}` / `{"tool_call_id":...}` lines. |

The sanitizer is conservative: legitimate `ts`, `js`, `json`, `py`, `sh`, etc.
fenced code blocks are preserved. A bare `{"type":...}` JSON line is **not**
considered a trace (too common in legitimate answers).

When the sanitizer removes or truncates anything, it emits a counts-only log:

```json
{
  "event": "auggie-router.output-sanitized",
  "skill": "refactor",
  "removedSections": 2,
  "truncated": false,
  "originalChars": 18204,
  "finalChars": 17612
}
```

Removed content is **never** logged.

## Context budgets by execution tier

When `contextBudgets.enabled` is `true`, the sub-agent's Auggie overflow ceiling
is selected from a per-tier pool instead of the static top-level
`overflowCeilingBytes`. A low-risk read-only task gets a smaller payload window
than a high-risk architecture refactor. The selected ceiling is sticky for the
whole sub-agent run.

| Setting | Default | Purpose |
| --- | --- | --- |
| `contextBudgets.enabled` | `false` | Master switch. When `false`, the top-level `overflowCeilingBytes` is used as before. |
| `contextBudgets.overflowCeilingBytes.cheap` | `15000` | Ceiling for read-only / low-complexity work. |
| `contextBudgets.overflowCeilingBytes.balanced` | `25000` | Ceiling for scoped edits / medium-complexity work. |
| `contextBudgets.overflowCeilingBytes.frontier` | `50000` | Ceiling for multi-file / architecture / high-risk work. |

**Tier selection rule.** When adaptive execution routing produced the model
(`selection.source === "execution-routing"`), the model's tier drives the
budget — the actual runtime tier after preference + safety floors + pool
fallback. For pinned `SKILL.md model:` runs or legacy fallback, the Judge's
classification (`route.tier`) is used as the only meaningful signal; with
adaptive routing disabled this collapses to "balanced" and the budget is
effectively static.

**Missing tier fallback.** If a tier is omitted from the pool, the router uses
the top-level `overflowCeilingBytes` instead. A partial pool is intentional —
no implicit backfill from defaults.

When enabled, every run emits a structured log:

```json
{
  "event": "auggie-router.context-budget",
  "skill": "refactor",
  "tier": "cheap",
  "overflowCeilingBytes": 15000,
  "source": "tier"
}
```

`source` is one of `"static"` (disabled), `"tier"` (tier hit a configured
value), or `"tier-fallback"` (tier missing from pool, used top-level ceiling).
No prompts, history, or user content are logged.

Note: history/routing-prompt budgets are intentionally NOT tier-driven yet —
history must be assembled before the Judge knows the tier. See the next
section for the (separate) history-assembly knob.

## Chat-history assembly

The Actor/Judge loop pulls recent messages via `host.getRecentMessages(historyWindow)`.
With long sessions, the earliest goal-setting messages can fall out of the
window — increasing `historyWindow` solves that but bloats every routing call.

`historyAssembly` provides an explicit reducer between `getRecentMessages` and
brief construction. Two strategies:

| Strategy | Behaviour |
| --- | --- |
| `recent` (default) | Pass the host-provided window through unchanged. Legacy behaviour. |
| `headTail` | Keep the first `headMessages` and last `tailMessages` of the window. Drop the middle or replace it with an explicit marker. Apply per-message and total char caps. |

| Setting | Default | Purpose |
| --- | --- | --- |
| `historyAssembly.strategy` | `"recent"` | `"recent"` or `"headTail"`. |
| `historyAssembly.headMessages` | `2` | Leading messages preserved (only used by `headTail`). |
| `historyAssembly.tailMessages` | `12` | Trailing messages preserved (only used by `headTail`). |
| `historyAssembly.middleMode` | `"marker"` | `"marker"` inserts a `[history-omitted-middle: N message(s), ~M chars]` system message; `"omit"` drops the middle silently. |
| `historyAssembly.maxCharsPerMessage` | `10000` | Per-message char cap. `0` disables. |
| `historyAssembly.maxTotalChars` | `60000` | Total assembled char cap. `0` disables. |

**Total-cap eviction order** when content exceeds `maxTotalChars`:

1. Any `[history-omitted-middle: …]` marker is dropped first — it's already
   a placeholder for absent content, so losing it costs nothing real.
2. Interior messages are dropped from the geometric middle outwards. The
   first and last entries are preserved as anchors.
3. If only the two anchors remain and the total still exceeds the cap, the
   last anchor's content is truncated to fit (including the truncation
   marker) within the cap.

**Host limitation.** The current `PiHost` API only exposes
`getRecentMessages(N)`. "Head" therefore means the earliest entries inside
that window — not necessarily the true start of the session. A future host
API could surface session-start messages directly.

The router still applies the existing 10 000-char-per-message safety
truncation inside `buildActorMessages` / `buildJudgeMessages`. If the
assembler's `maxCharsPerMessage` already cut content, that pass is a no-op.

## Prompt-prefix cache stability

The sub-agent system prompt is built deterministically from the skill
instructions and an optional appendix only — no dynamic data (selected model,
execution route, brief, user goal) enters the prefix. This invariant maximizes
provider prompt-cache hit rate across repeated invocations of the same skill.

Use `buildSubAgentSystemPrompt({ skillInstructions, appendix })` from the public
API to compute the same prefix in tests or tooling.

For regression detection, enable hash-only debug logging:

```json
{
  "auggieRouter": {
    "debugPromptPrefixHash": true
  }
}
```

When enabled, every sub-agent run emits:

```json
{
  "event": "auggie-router.prompt-prefix",
  "skill": "refactor",
  "sha256": "…64 hex chars…",
  "bytes": 12345
}
```

Only the SHA-256 hash and byte length are logged — never the prompt text. A
changing hash across runs of the same skill (with identical appendix) signals
an accidental cache-busting regression.

## Overflow context memory

By default, oversized Auggie `codebase-retrieval` payloads are blocked and the
sub-agent is told to refine its query. When `contextMemory.enabled` is `true`,
those oversized payloads are instead stored in an execution-scoped temp store
and the replacement message includes:

- an overflow handle such as `overflow_1`,
- the original byte size,
- a bounded head/tail preview.

During the same sub-agent run, the router attaches a small `context-memory` MCP
server with two tools:

| Tool | Purpose |
| --- | --- |
| `context-memory.list` | List stored overflow entries by metadata only. |
| `context-memory.read` | Read a bounded character slice for a known overflow handle. |

The MCP read surface is intentionally narrow: `context-memory.read` caps each
slice at 32 000 characters and accepts only generated handles matching
`overflow_<n>`. The temp store is disposed after the sub-agent resolves or
rejects, so there is no cross-run memory.

| Setting | Default | Purpose |
| --- | --- | --- |
| `contextMemory.enabled` | `false` | Master switch. When `false`, legacy overflow replacement text is used. |
| `contextMemory.maxEntries` | `8` | Maximum stored overflow payloads per skill execution. |
| `contextMemory.maxBytesPerRun` | `1000000` | Cumulative byte cap per skill execution. |
| `contextMemory.previewHeadChars` | `4000` | Characters from the beginning included in the replacement preview. |
| `contextMemory.previewTailChars` | `4000` | Characters from the end included in the replacement preview. |

## Parallel sub-agent runner API

`runParallelSubagents(...)` is exported for hosts or advanced integrations that
want to split an already-known task into explicit independent subtasks. The
main `/skill` router does not automatically decompose user requests.

The feature is disabled by default and refuses to run unless
`parallelSubagents.enabled=true`. Each worker sub-agent receives the same stable
skill system prompt plus one compact subtask brief in its user prompt, its own
Auggie MCP stack, and isolated context-memory plumbing when enabled. Worker
outputs are capped before deterministic synthesis, so no extra LLM call is
needed to combine results.

| Setting | Default | Purpose |
| --- | --- | --- |
| `parallelSubagents.enabled` | `false` | Master switch for the explicit runner API. |
| `parallelSubagents.maxSubagents` | `3` | Maximum concurrent workers allowed by settings. Caller overrides are bounded by this cap. |
| `parallelSubagents.perWorkerOutputCharCap` | `8000` | Default cap for each worker's final text. `0` disables the cap. |

## Execution trace persistence

When `executionTrace.enabled` is `true` (the default), the router captures a
full transcript of every sub-agent execution and persists it to
`.pi/traces/<skillName>_<timestamp>.json`. Each trace contains:

- **Skill metadata**: name, model, brief, execution route
- **Tool calls**: server name, tool name, args, result preview (capped at
  `maxResultPreviewChars`), blocked flag, timestamp
- **Outcome**: final text and stopped reason

This data powers **trace observability** for skill debugging (see
[`docs/PRD-trace-observability.md`](docs/PRD-trace-observability.md)):
classifying trace outcomes, detecting skill degradation, and surfacing
actionable reports to users.

| Setting | Default | Purpose |
| --- | --- | --- |
| `executionTrace.enabled` | `true` | Master switch for trace capture and persistence. |
| `executionTrace.maxResultPreviewChars` | `2000` | Max characters kept from each tool result in the trace. Full payloads are not stored (could be megabytes of codebase content). |
| `executionTrace.traceDirectory` | `".pi/traces"` | Directory (relative to workspace root) where trace JSON files are stored. |

Old traces are automatically cleaned up after each run: count-based retention
keeps at most `maxTracesPerSkill` (default 20) trace files per skill, deleting
the oldest first. Use `cleanupTraces(dir, opts)` from the public API to trigger
cleanup manually.

## Trace Observability

When `traceObservability.enabled` is `true` (the default), the router adds a
lightweight observability layer on top of execution traces:

classifying outcomes, detecting degradation, and surfacing actionable reports.

### Commands

| Command | Purpose |
| --- | --- |
| `/skill:trace-report <name>` | Show a summary report for a skill's recent execution history — outcome distribution, common failure signals, trend line, and recent traces. |
| `/skill:trace-view <filename>` | Show a detailed tool-call timeline for a single trace file — timestamps, args, result sizes, duration, and final text. |

These commands are intercepted before Pi's default `/skill` handler runs.

### Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `traceObservability.enabled` | `true` | Master switch for classification, degradation alerts, and reports. |
| `traceObservability.showReportAfterExecution` | `false` | Show a compact mini-report (last 3 traces) after every skill execution. |
| `traceObservability.degradationAlertEnabled` | `true` | Emit a system message when a skill fails N consecutive times after prior success. |
| `traceObservability.degradationConsecutiveFailures` | `3` | Consecutive failures required to trigger a degradation alert. |
| `traceObservability.degradationAlertCooldownHours` | `24` | Minimum hours between repeated alerts for the same skill. |
| `traceObservability.reportMaxTraces` | `10` | Maximum traces loaded and classified for on-demand reports. |
| `traceObservability.reportMaxInlineTraces` | `5` | Maximum recent traces shown inline; larger datasets truncate with a count. |
| `traceObservability.regressionWindowSize` | `10` | Number of historical traces examined for regression detection. |
| `traceObservability.maxTracesPerSkill` | `20` | Maximum trace files retained per skill (count-based cleanup, oldest deleted first). |

### Skip-Judge mode

Setting `maxJudgeIterations` to `0` skips the Judge entirely. The Actor
produces a brief, the rubric auto-passes, and the default execution route
is used. This eliminates the verification overhead for simple or
well-known skills:

```json
{
  "auggieRouter": {
    "maxJudgeIterations": 0
  }
}
```

## Execution flow

1. **Intercept** — `onUserInput` matches `/skill:trace-view`, `/skill:trace-report`,
   then `^/skill:([a-zA-Z0-9_-]+)`, swallows
   the input, and prevents Pi's default skill handler from running.
2. **Locate & parse** — looks for `SKILL.md` in `.pi/skills/<name>/` first,
   then `~/.pi/agent/skills/<name>/`. Frontmatter is parsed with
   `gray-matter`; only `model:` is honoured.
3. **2-pass Actor/Judge loop** — drafts a `{userGoal, constraints, knownContext}`
   brief, scores it against a binary rubric, rewrites once if any boolean is
   `false`. Hard cap = 2 passes. When `maxJudgeIterations=0`, the Judge is
   skipped entirely (Actor only, auto-pass).
4. **Q&A fallback** — if the second pass still fails, the Judge's
   `missingRequirementQuestion` is posted to the user. The next typed message
   is intercepted via `onBeforeMessage`, appended to the brief as a
   clarification, and execution resumes.
5. **Auggie pre-flight** — `auggie account status` is spawned silently. Any non-zero
   exit aborts with `[System Error]: Cannot execute skill. Augment daemon is
   offline or unauthenticated.`
6. **Execution model selection** — the router computes the sub-agent model.
   When adaptive routing is disabled (default), this is the legacy
   `mapModel(skill.rawModel, ...)` path. When enabled, the Judge's
   `executionRoute` is combined with preference, safety floors, and the
   configured pool to select exactly one model. The selection is sticky for
   the entire run and never injected into the sub-agent prompt.
7. **Context budget selection** — if `contextBudgets.enabled=true`, the router
   chooses a per-tier overflow ceiling for the run. Otherwise it uses the
   static top-level `overflowCeilingBytes`.
8. **Sub-agent execution** — the input editor is locked, a `[System]: ⚙️ Executing …`
   marker is posted, and an isolated Pi sub-agent runs at `temperature: 0.0`
   with the `auggie` MCP attached over stdio. If `contextMemory.enabled=true`,
   the execution-scoped `context-memory` MCP is attached too. If
   `executionTrace.enabled=true`, a trace middleware captures every tool call.
   The sub-agent's prompt is appended with the `AUGGIE_DIRECTIVE`:
   *"Use the `codebase-retrieval` MCP tool for workspace context."*
   Structured route, context-budget, and optional prompt-prefix logs are emitted
   at this point.
9. **Overflow middleware** — every oversized `auggie/codebase-retrieval` response
   is blocked. With context memory disabled, it is replaced with `"Result too
   large. Please refine your codebase-retrieval query to be more specific."`
   With context memory enabled, the payload is stored execution-locally and the
   replacement includes an overflow handle plus bounded preview.
10. **Resolution** — final sub-agent text is sanitized according to
    `outputSanitizer`, posted to the main thread, the editor is unlocked, and the
    state machine resets to `idle`.
11. **Trace persistence** — if `executionTrace.enabled`, the trace store is
    finalized with the sub-agent's output and persisted to `.pi/traces/`. Old
    traces are cleaned up (7-day TTL, 500-file cap). A structured
    `auggie-router.execution-trace` log event is emitted.

## State machine

```
   idle ──/skill:──▶ evaluating ──pass──▶ executing ──done──▶ idle
                         │
                         └─fail×2─▶ waitingForUser ──answer──▶ executing
```

Only one skill can be in flight at a time. New `/skill:` commands while busy
get a `[System]: Router busy` warning.

## Operational defaults

| Knob                      | Default                          | Why                                                |
| ------------------------- | -------------------------------- | -------------------------------------------------- |
| Routing engine            | `anthropic/claude-3-5-haiku`     | Cheap and Anthropic-aligned for routing.           |
| History window            | 20 messages                      | Enough for context, not enough to drown the brief. |
| Total timeout             | 300 s                            | Hard kill prevents runaway billing.                |
| MCP inactivity timeout    | 60 s                             | Stops OpenRouter loops when a model hangs.         |
| Sub-agent temperature     | 0.0                              | Mandatory for rigid tool usage.                    |
| Overflow ceiling          | 25 000 B                         | Forces query refinement, not context dumping.      |
| Auggie binary path        | `"auggie"`                       | Relies on `$PATH` by default; override for security.|
| Allowed provider prefixes | `[]` (allow all)                 | Restrict to known providers to prevent model redirection. |
| Adaptive routing          | disabled                         | Backwards-compatible opt-in.                       |
| Adaptive preference       | `balanced`                       | Neutral cost-quality bias.                         |
| Skill model policy        | `pin`                            | Preserve existing `SKILL.md model:` behavior.      |
| Surface routing decision  | `false`                          | Keep default UI minimal.                           |
| Output sanitizer          | enabled                          | Keeps tool traces out of the main chat.            |
| Context budgets           | disabled                         | Static overflow ceiling unless explicitly enabled. |
| History assembly          | `recent`                         | Preserve legacy history behavior by default.       |
| Context memory            | disabled                         | Legacy overflow replacement unless opted in.       |
| Parallel sub-agents       | disabled                         | Explicit advanced API only.                        |

## Security model

### Trust boundary: workspace filesystem

`pi-auggie-router` loads SKILL.md files from the workspace (`.pi/skills/`)
and the user's home directory (`~/.pi/agent/skills/`). The **markdown body** of
a skill file is injected verbatim into LLM prompts (routing model and
sub-agent). This means:

- Any process that can write to `.pi/skills/*/SKILL.md` effectively controls
  the sub-agent's system prompt (prompt injection via filesystem).
- A malicious `model:` value in SKILL.md frontmatter can redirect execution to
  a different provider. Use `allowedProviderPrefixes` to restrict this.
- Do **not** commit SKILL.md files from untrusted sources without review.

### Data sent to LLM providers

The routing model (`claude-3-5-haiku` by default) sees:

- The skill's markdown instructions.
- The last `historyWindow` chat messages (truncated to 10 000 chars each).
- Actor/Judge JSON payloads.
- Judge routing metadata requests/outputs, including `executionRoute`
  (`tier`, `complexity`, `risk`, `confidence`, `reason`).

The sub-agent does **not** receive route metadata in its system or user prompt;
route decisions are surfaced only through host system messages and structured
logs. If your chat may contain secrets, point `routingModel` at a self-hosted
gateway or reduce `historyWindow`.

### Path resolution

Skill names are validated against `[a-zA-Z0-9_-]+` — no dots, slashes, or
path traversal sequences. Error messages omit filesystem paths to prevent
information leakage.

### Sub-process spawning

The router spawns the `auggie` binary for pre-flight checks and as an MCP
server. By default it relies on `$PATH` lookup; set `auggieBinPath` to an
absolute path to eliminate this attack surface. stderr from `auggie account status`
is redacted for common secret patterns (API keys, Bearer tokens, hex strings)
before being surfaced in the UI.

## Development

```bash
npm install
npm run build       # compile to dist/
npm run lint        # tsc --noEmit
npm test            # node --test via tsx loader
```

## License

MIT
