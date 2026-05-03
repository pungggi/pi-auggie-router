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
    "allowedProviderPrefixes": []
  }
}
```

> **Note on data exposure:** the routing-class model (default
> `claude-3-5-haiku` via OpenRouter) sees the last `historyWindow` chat
> messages. If your chat may contain secrets, point `routingModel` at a
> self-hosted gateway or trim `historyWindow`.

Defaults match the values shown above. Only `defaultProvider` is expected to
change in normal use; everything else is opinionated for a reason.

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

If your chat may contain secrets, point `routingModel` at a self-hosted gateway
or reduce `historyWindow`.

### Path resolution

Skill names are validated against `[a-zA-Z0-9_-]+` — no dots, slashes, or
path traversal sequences. Error messages omit filesystem paths to prevent
information leakage.

### Sub-process spawning

The router spawns the `auggie` binary for pre-flight checks and as an MCP
server. By default it relies on `$PATH` lookup; set `auggieBinPath` to an
absolute path to eliminate this attack surface. stderr from `auggie status`
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
