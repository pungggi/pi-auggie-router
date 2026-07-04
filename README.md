# pi-auggie-router

> Opinionated `/skill:` sub-agent router for the Pi framework.
> Tightly couples Anthropic-style `SKILL.md` execution with the
> Augment Code (`auggie`) Context Engine via MCP.

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
(`auggie status` must exit 0).

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
| `registerAutocomplete` (optional) | Declare the `/skill:` completion trigger (Pi ≥ 0.79.1).       |
| `onCompaction` (optional) | Compaction events driving the adaptive overflow ceiling (Pi ≥ 0.79.10). |
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
    "routingMaxRetries": 2,
    "routingRetryBaseDelayMs": 250,
    "qaTimeoutMs": 300000,
    "totalTimeoutMs": 300000,
    "inactivityTimeoutMs": 60000,
    "subAgentTemperature": 0.0,
    "overflowCeilingBytes": 25000,
    "overflowFloorBytes": 5000
  }
}
```

> **Note on data exposure:** the routing-class model (default
> `claude-3-5-haiku` via OpenRouter) sees the last `historyWindow` chat
> messages. If your chat may contain secrets, point `routingModel` at a
> self-hosted gateway or trim `historyWindow`.

Defaults match the values shown above. Only `defaultProvider` is expected to
change in normal use; everything else is opinionated for a reason.

> **Routing retries:** thrown `callLLM` errors (network blips, 429/5xx) are
> retried up to `routingMaxRetries` times with exponential backoff
> (`routingRetryBaseDelayMs`, doubling per attempt). Timeouts are never
> retried — they already consumed `routingTimeoutMs` and degrade into the
> Judge fallback / Q&A path instead. If your host already retries at
> provider level (Pi ≥ 0.76.0 `retry.provider.maxRetries`), set
> `routingMaxRetries` to `0` so attempts don't multiply.

### Skill `model:` translation

The `model:` field in a skill's frontmatter is translated through
`mapModel(rawModel, defaultProvider)`:

| Frontmatter `model`                       | Resolved gateway ID                                |
| ----------------------------------------- | -------------------------------------------------- |
| `claude-3-7-sonnet`                       | `openrouter/anthropic/claude-3-7-sonnet`           |
| `anthropic/claude-3-5-haiku`              | `openrouter/anthropic/claude-3-5-haiku`            |
| `openrouter/anthropic/claude-3-5-sonnet`  | _(unchanged — already fully qualified)_            |
| _(missing)_                               | `openrouter/anthropic/claude-sonnet-5` (fallback)  |

## Skill autocomplete

On hosts that implement the optional `registerAutocomplete` method (Pi ≥
0.79.1 natural extension autocomplete), the router declares `/skill:` as a
completion trigger. While the user types the skill name, the router scans
`.pi/skills/*/SKILL.md` and `~/.pi/agent/skills/*/SKILL.md` (workspace
shadows home, same precedence as execution) and suggests matching names.
A frontmatter `description:` in the `SKILL.md` is surfaced next to each
suggestion. Hosts without autocomplete support are unaffected.

## Execution flow

1. **Intercept** — `onUserInput` matches `^/skill:([a-zA-Z0-9_-]+)`, swallows
   the input, and prevents Pi's default skill handler from running.
2. **Locate & parse** — looks for `SKILL.md` in `.pi/skills/<name>/` first,
   then `~/.pi/agent/skills/<name>/`. Frontmatter is parsed with
   `gray-matter`; only `model:` is honoured.
3. **2-pass Actor/Judge loop** — drafts a `{userGoal, constraints, knownContext}`
   brief, scores it against a binary rubric, rewrites once if any boolean is
   `false`. Hard cap = 2 passes.
4. **Q&A fallback** — if the second pass still fails, the Judge's
   `missingRequirementQuestion` is posted to the user. The next typed message
   is intercepted via `onBeforeMessage`, appended to the brief as a
   clarification, and execution resumes.
5. **Auggie pre-flight** — `auggie status` is spawned silently. Any non-zero
   exit aborts with `[System Error]: Cannot execute skill. Augment daemon is
   offline or unauthenticated.`
6. **Sub-agent execution** — the input editor is locked, a `[System]: ⚙️ Executing …`
   marker is posted, and an isolated Pi sub-agent runs at `temperature: 0.0`
   with the `auggie` MCP attached over stdio. The sub-agent's prompt is
   appended with: *"To gather context, you MUST strictly use the MCP tool
   named `codebase-retrieval`. Do not attempt to run auggie in the terminal."*
7. **Overflow middleware** — every `auggie/codebase-retrieval` response over
   25 KB (configurable) is dropped and replaced with `"Result too large.
   Please refine your codebase-retrieval query to be more specific."`
   On hosts that expose compaction events (Pi ≥ 0.79.10 `onCompaction`),
   the ceiling is adaptive: each automatic compaction that will retry the
   interrupted request (`reason: "threshold" | "overflow"`, `willRetry: true`)
   halves the ceiling down to `overflowFloorBytes`, so the retried turn pulls
   smaller payloads instead of re-triggering the same overflow. Manual
   compactions never shrink it. The ceiling resets to the configured value
   at the start of every skill run.
8. **Resolution** — final sub-agent text is posted to the main thread, the
   editor is unlocked, the state machine resets to `idle`.

## State machine

```
   idle ──/skill:──▶ evaluating ──pass──▶ executing ──done──▶ idle
                         │
                         └─fail×2─▶ waitingForUser ──answer──▶ executing
```

Only one skill can be in flight at a time. New `/skill:` commands while busy
get a `[System]: Router busy` warning.

## Hardcoded defaults (PRD §4)

| Knob                    | Default                          | Why                                                |
| ----------------------- | -------------------------------- | -------------------------------------------------- |
| Routing engine          | `anthropic/claude-3-5-haiku`     | Cheap and Anthropic-aligned for routing.           |
| History window          | 20 messages                      | Enough for context, not enough to drown the brief. |
| Total timeout           | 300 s                            | Hard kill prevents runaway billing.                |
| Routing retries         | 2 × (250 ms backoff, doubling)   | Survives transient provider errors; timeouts excluded. |
| MCP inactivity timeout  | 60 s                             | Stops OpenRouter loops when a model hangs.         |
| Sub-agent temperature   | 0.0                              | Mandatory for rigid tool usage.                    |
| Overflow ceiling        | 25 000 B                         | Forces query refinement, not context dumping.      |
| Overflow floor          | 5 000 B                          | Lower bound for the adaptive post-compaction ceiling. |

## Development

```bash
npm install
npm run build       # compile to dist/
npm run lint        # tsc --noEmit
npm test            # node --test via tsx loader
```

## License

MIT
