# Getting Started

This guide walks you through your first `/skill` workflow inside the **pi.dev terminal** (`@earendil-works/pi-coding-agent`).

`pi-auggie-router` ships as a pi.dev extension. Install once with `pi install npm:pi-auggie-router` — pi auto-loads it on every launch from there on.

(If you also want DDD workflow enforcement, install [`pi-ddd-router`](../pi-ddd-router/README.md) instead. It composes this router + `pi-ddd` in one extension.)

## Prerequisites

1. **pi.dev** (`@earendil-works/pi-coding-agent`) installed and on `PATH` (`pi --help` works).
2. **Augment Code CLI** (`auggie`) installed and authenticated. From any shell:
   ```bash
   auggie status
   ```
   Must exit `0` and report `connected`. If not, install from [augmentcode.com](https://www.augmentcode.com/) and run `auggie login`.
3. **An OpenRouter key** (or whichever provider you point `defaultProvider` at) configured in pi.dev — this is what the routing-class model and sub-agent calls go through.

## Step 0: Install the extension

```bash
pi install npm:pi-auggie-router
```

That's it. `pi install` reads the package's `pi.extensions` field and registers `extension.ts` in your pi settings — auto-loaded on every `pi` launch.

Scope:
- Default = global (`~/.pi/settings.json`).
- Add `-l` for project-local (`.pi/settings.json` in the workspace).

```bash
pi install npm:pi-auggie-router -l   # only this project
```

Verify:

```bash
pi list
```

Should show `pi-auggie-router`. Remove with `pi remove npm:pi-auggie-router`.

Other sources also accepted (`git:`, `https:`, local path) — see `pi install --help`.

## Step 1: Verify the router is live

On launch you should see three startup warnings from the bridge:

```
[pi-auggie-router/bridge] [warn] ExtensionAPI.setInputLocked() not found - falling back to sendMessage or stderr for input locking.
[pi-auggie-router/bridge] [warn] onUserInput has limited support via extension bridge. /skill: interception may require pi.registerCommand fallback.
[pi-auggie-router/bridge] [warn] onBeforeMessage is not supported via extension bridge. Q&A fallback will not work.
```

These confirm the extension loaded. They are expected — pi.dev's extension API does not currently expose the host hooks the router would prefer. Read [Bridge limitations](#bridge-limitations) below before going further.

Then run:

```
/skill does-not-exist
```

(Note: **no colon**. The slash-command form goes through `pi.registerCommand`, which is the only reliable interception path.) You should see:

```
[System]: Skill "does-not-exist" not found.
```

If instead pi prints `Unknown command: /skill`, the extension did not register — the most common cause is that you installed an older version that predates the `pi.extensions` manifest field. Run:

```bash
pi update pi-auggie-router
pi list                        # confirm version ≥ 1.2.0
```

The `/skill:<name>` (with colon) form **does not work** through the extension bridge — it falls through to the main agent and is interpreted as plain text.

## Bridge limitations

pi.dev's `ExtensionAPI` does not expose every host hook the router would use if mounted directly. Three concrete consequences:

| Warn at startup                   | What it means                                                                                                                          | Workaround                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `setInputLocked() not found`      | Input box is **not** locked while a skill runs. You can keep typing — those messages will queue or interleave.                         | Cosmetic only. Don't type while a skill executes.                                                |
| `onUserInput has limited support` | The `/skill:<name>` (colon) prefix cannot be intercepted before the model sees it.                                                     | Use `/skill <name>` (slash-command form). Same router, just a different entry path.              |
| `onBeforeMessage not supported`   | The Q&A clarification fallback (Judge → user → resume execution) cannot capture your reply. If the Judge needs clarification, it dies. | Write skills tight enough that the Judge passes on the first try. See troubleshooting below.     |

These limitations are pi.dev-side; the router itself supports all three hooks via the `PiHost` contract when mounted directly. If/when pi-coding-agent grows full extension hooks, the warns disappear.

## Step 2: Configure (optional)

Defaults work for most cases. To override, create `.pi/settings.json` at the root of your workspace:

```json
{
  "auggieRouter": {
    "defaultProvider": "openrouter",
    "routingModel": "anthropic/claude-3-5-haiku",
    "executionRouting": {
      "enabled": true,
      "preference": "balanced",
      "surfaceDecision": true,
      "models": {
        "cheap": "anthropic/claude-3-5-haiku",
        "balanced": "anthropic/claude-3-5-sonnet",
        "frontier": "anthropic/claude-3-7-sonnet"
      }
    }
  }
}
```

`surfaceDecision: true` makes the router announce which tier it picked and why. Useful while you are tuning skills. See [README.md](README.md#configuration) for every knob.

User-level defaults can also live at `~/.pi/settings.json`; workspace overrides win.

## Step 3: Write your first skill

Skills live at:

- `.pi/skills/<name>/SKILL.md` — workspace-scoped (committed with the repo)
- `~/.pi/agent/skills/<name>/SKILL.md` — user-scoped (available everywhere)

Workspace skills win on name collision.

### Example A — pinned model

`.pi/skills/refactor/SKILL.md`:

```markdown
---
model: claude-3-5-sonnet
---

You are a code refactoring assistant.

Improve code quality while preserving exact behavior:
- Extract helpers from long functions
- Rename for self-documentation
- Remove dead code and unused imports
- Apply Prettier-style formatting
- Add JSDoc on public functions

Constraints:
- Do not change exported public APIs
- Do not modify test files
- Do not change business logic
- Run the linter after refactoring
```

### Example B — adaptive routing

`.pi/skills/explain/SKILL.md`:

```markdown
---
# No model: → adaptive routing chooses based on complexity/risk
---

You are a code-explanation assistant. For each function or class:
- One-sentence purpose
- Inputs and outputs
- Side effects
- Non-obvious patterns or anti-patterns

Keep it 2–3 sentences per function. Focus on the "why".
```

With `executionRouting.enabled = true` and `preference = "balanced"`, a read-only explain task will usually drop to the cheap tier.

### Example C — tests

`.pi/skills/test/SKILL.md`:

```markdown
---
---

You are a TDD assistant. Add unit tests for the code in context.

Requirements:
- Use the project's test framework (detect from package.json / config)
- Cover public functions, edge cases, error paths
- Mock external deps
- Descriptive test names

Constraints:
- Do not modify code under test
- Place tests next to the source
```

## Step 4: Run the skill

In the pi.dev terminal:

```
/skill refactor Clean up src/utils/auth.ts
```

What happens, in order:

1. Router intercepts `/skill refactor`, loads `.pi/skills/refactor/SKILL.md`.
2. Pre-flight check: `auggie status` must be green.
3. **Actor/Judge loop** runs against the routing model — turns your one-liner into a structured brief and decides if more context is needed.
4. **Execution model** is picked: `model:` frontmatter, or adaptive routing if enabled.
5. A sub-agent spins up with the Augment MCP attached and is forced to call `codebase-retrieval` for context — no raw file dumps.
6. The sub-agent applies the skill instructions and returns a synthesized result.
7. Result lands in the main thread.

While the skill runs, system messages tell you what stage you are in. Note that under the pi.dev bridge the input box is **not** locked (see [Bridge limitations](#bridge-limitations)) — don't type while a skill executes.

## Step 5: Example session

You type:

```
/skill test Add tests for src/services/user.ts
```

Terminal shows:

```
[System]: ⚙️ Executing /skill:test (Auggie semantic retrieval running...)
```

Then the assistant message lands:

```
I'll add comprehensive unit tests for `src/services/user.ts`.

[sub-agent uses codebase-retrieval MCP tool]

Tests added:

// src/services/user.test.ts
import { UserService } from './user';
import { mockUserRepository } from '../mocks';

describe('UserService', () => {
  describe('findById', () => {
    it('returns the user when found', async () => { /* ... */ });
    it('returns null when user not found', async () => { /* ... */ });
    it('handles repository errors gracefully', async () => { /* ... */ });
  });
});

All tests cover the public API, edge cases, and error conditions.
```

If adaptive routing is on with `surfaceDecision: true`, you also see one line like:

```
[System]: ⚙️ Executing /skill:test using balanced model openrouter/anthropic/claude-3-5-sonnet. Reason: route balanced (complexity=medium, risk=write_tests, confidence=0.88)
```

## Troubleshooting

### Augment daemon offline

```
[System Error]: Cannot execute skill. Augment daemon is offline or unauthenticated.
```

In a separate shell:

```bash
auggie status
auggie login    # if unauthenticated
```

Re-run the skill once `auggie status` exits 0.

### Skill not found

```
[System]: Skill "myskill" not found.
```

Check the path. Workspace path must be exactly `.pi/skills/myskill/SKILL.md` (case matters on Linux/macOS). User path must be `~/.pi/agent/skills/myskill/SKILL.md`.

### Q&A clarification prompt

```
[System]: Missing context for skill. Which files should I focus on?
```

The Judge couldn't pin down the scope.

> **Important under pi.dev bridge:** the Q&A capture path uses `onBeforeMessage`, which the bridge does not expose (see startup warn `onBeforeMessage is not supported`). Your typed reply will be sent to the main agent as a normal message instead of being attached to the brief. The skill run will time out at `qaTimeoutMs` and abort.
>
> **Workaround:** re-run with a more specific input, e.g. `/skill refactor src/utils/auth.ts and src/middleware/auth.ts`. Tighten the skill prompt so the Judge passes without clarification.

When the router is mounted directly in a host (not via the bridge), the typed reply is appended to the brief as a clarification and execution proceeds without re-running Actor/Judge.

### Sub-agent timeout

```
[System]: Sub-agent stopped early (timeout).
```

Either bump `totalTimeoutMs` in `.pi/settings.json`, or narrow the input ("refactor `parseToken`" instead of "refactor the auth module").

### Disallowed model provider

```
[System]: Sub-agent failed: Model "evil/vendor/model" uses a disallowed provider. Allowed prefixes: openrouter
```

Either change the skill's `model:` to an allowed provider, or extend the allowlist:

```json
{
  "auggieRouter": {
    "allowedProviderPrefixes": ["openrouter", "myco"]
  }
}
```

## Next steps

- **Adaptive routing tuning** — see [README.md](README.md#adaptive-execution-model-routing) for `preference`, `skillModelPolicy`, and safety floors.
- **Custom MCP servers / tool middleware** — host-level extension; not configurable from `.pi/settings.json` alone. Talk to whoever maintains the pi.dev build you are using.
- **Security model** — see [README.md](README.md#security-model) before pointing `routingModel` at anything outside your trust boundary; the routing model sees the last `historyWindow` chat messages.

## Full adaptive workflow, end to end

1. Enable in `.pi/settings.json`:
   ```json
   {
     "auggieRouter": {
       "executionRouting": {
         "enabled": true,
         "preference": "preferCheap",
         "surfaceDecision": true
       }
     }
   }
   ```

2. Drop a no-model skill at `.pi/skills/docs/SKILL.md`:
   ```markdown
   Generate API documentation for the code in context.
   Use Markdown with JSDoc-style parameter docs.
   ```

3. Run it in the pi.dev terminal:
   ```
   /skill docs Document src/api/routes.ts
   ```

4. Observe:
   ```
   [System]: ⚙️ Executing /skill:docs using cheap model openrouter/anthropic/claude-3-5-haiku. Reason: route cheap (complexity=low, risk=read_only, confidence=0.95)
   ```

Read-only, low-complexity → cheap tier. Same skill on a riskier target (e.g. a generator that mutates code) would route up.
