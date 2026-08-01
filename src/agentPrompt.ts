/**
 * Agent system-prompt injection for pi-auggie-router.
 *
 * The router needs the main agent to follow specific conventions when
 * delegating to skills (slash-command syntax, no pre-loading of files,
 * no re-doing sub-agent work, bridge limitations, etc.). Rather than
 * ask every user to maintain a hand-written `APPEND_SYSTEM.md`, this
 * module ships the rules with the package and injects them
 * automatically on every `before_agent_start` event.
 *
 * Three guarantees:
 *
 *   1. **Versioned** — the block is a string constant in this file.
 *      When the package is upgraded, the new rules ship automatically;
 *      no user action required.
 *   2. **Single source of truth** — the block is injected via the
 *      `before_agent_start` hook. We do NOT bootstrap a separate
 *      `~/.pi/agent/APPEND_SYSTEM.md` file, because Pi loads that path
 *      automatically and would end up duplicating the content. Users
 *      who want to see the source can read this file directly (or
 *      `dist/agentPrompt.js` after build).
 *   3. **Escape hatch** — `auggieRouter.promptInjection.enabled: false`
 *      in `.pi/settings.json` disables the hook entirely.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The versioned prompt block. Update this string when the rules change.
 *
 * Kept as a plain string constant so it can be exported and unit-tested
 * without a build step. Markdown is intentional — the rest of the
 * system prompt is markdown and the model formats consistently.
 */
export const AGENT_PROMPT_BLOCK = `## Delegating to skills (pi-auggie-router)

You have access to specialized sub-agents ("skills") registered as Pi
commands. Each skill is a focused role backed by a \`SKILL.md\` file.
Skills come in two flavours, and they run in different places:

- **Routed** skills (AFK / coding: \`refactor\`, \`test\`, \`explain\`,
  \`research\`, …) run in an **isolated sub-agent**. They retrieve
  workspace context semantically through the Augment
  \`codebase-retrieval\` MCP tool — they do not read raw files into
  context. The router owns them: it runs a 2-pass Actor/Judge brief loop,
  picks the execution model, and sanitizes the output.
- **In-session** skills (HITL / manual: \`wayfinder\`, \`grilling\`,
  \`setup-*\`, \`domain-modeling\`, \`prototype\`, \`grill-me\`, …) run
  in **this** session. Pi loads their \`SKILL.md\` into your context and
  you drive them interactively — multi-turn Q&A with the human, reading
  companion files next to \`SKILL.md\`, recording decisions in the live
  chat.

### When to delegate to a skill

For any user request that matches a registered skill's role, prefer
delegating to that skill over doing the work inline. Inline handling
duplicates effort, pollutes your main context with raw file dumps,
and bypasses the router's adaptive model selection and output
sanitization.

Match by **intent**, not by literal keyword. A request like "clean up
this function" matches the \`refactor\` skill; "what does this code
do" matches \`explain\`; "add coverage for this module" matches \`test\`.

If no skill fits, do the work inline as usual.

### Skill invocation (two modes)

**1. Routed (AFK / coding) — the router owns it.** Both forms work and
are equivalent; the colon form is the canonical user syntax, the
space form is the agent-delegation syntax:

    /skill <name> <task description>
    /skill:<name> <task description>

Spawns an isolated sub-agent (Auggie retrieval, sanitized answer).
Use for refactor, test, explain, research, and similar bounded tasks
with a clear deliverable.

    /skill refactor Clean up src/utils/auth.ts — extract helpers, keep public API
    /skill test Add unit tests for the new discount tiers in src/services/billing/calculator.ts
    /skill explain src/services/billing/calculator.ts

**2. In-session (HITL / manual) — you own it.** The router steps aside
and Pi loads \`SKILL.md\` into THIS session; you then follow it
interactively. Use the explicit escape hatch, or rely on the skill's
frontmatter opt-out (\`disable-model-invocation: true\`, \`router: false\`,
or \`execution: in-context\`):

    /skill-local:<name> …
    /skill!:<name> …        (same thing)
    /skill:<name>           (when the skill opts out via frontmatter)

Use for wayfinder, grilling, setup-*, domain-modeling, prototype,
grill-me, and any skill that needs multi-turn human answers, companion
files next to \`SKILL.md\`, or decisions recorded in the live chat.

### Hard rules

- **Never** read the target file into your own context before a
  **routed** delegation. The sub-agent retrieves semantically;
  pre-loading defeats the point and wastes tokens. Pass only the file
  path and intent. (For an **in-session** skill, you SHOULD read
  \`SKILL.md\` and its relative companions — that is how those skills
  work.)
- **Never** re-retrieve or re-execute a routed skill's work after the
  sub-agent returns. The result is already synthesized and tool traces
  are stripped. Treat the returned message as the final answer.
- **Never** invoke the interactive skill picker (\`/skill\` with no
  arguments). That is a user-facing UI; you must always specify the
  skill name yourself.
- **Never** invoke \`/skill:trace-report\` or \`/skill:trace-view\` on the
  user's behalf. Those are observability commands the user runs
  manually.
- **Never** delegate an in-session (HITL) skill to the routed
  sub-agent path. If a skill is interactive, use
  \`/skill-local:<name>\` so it runs here, not in an isolated agent.

### Writing a good task description

The router runs a 2-pass Actor/Judge loop on a cheap model to refine
your one-liner into a structured brief. The better your input, the
better the brief. Be specific:

- **Good**: \`/skill refactor src/utils/auth.ts — extract helpers, keep public API stable\`
- **Bad**: \`/skill refactor this file\`

Include the file path, the desired outcome, and any constraints the
user mentioned. If the user gave no constraints, do not invent them.

### Bridge limitations you must respect

The pi.dev extension bridge has three known gaps. Adjust your
behavior accordingly:

1. **Input is not locked while a skill runs.** Do not produce
   intermediate prose or tool calls while \`[System]: ⚙️ Executing...\`
   is on screen. The user may be typing — let the skill finish.
2. **The Q&A clarification fallback is broken.** If the task is
   ambiguous, either ask the user **once** in your own response
   *before* delegating, or pick the most likely interpretation and
   note your assumption. Do not delegate an under-specified task and
   expect to be asked back — that path will time out and abort.
3. **Tool traces are stripped from sub-agent output.** The message
   you receive is the final synthesized answer, not a transcript.
   Do not ask the user "would you like to see the tool calls" — you
   do not have them.

### Failure handling

If the skill returns a \`[System Error]: ...\` or
\`[System]: Sub-agent stopped early (timeout).\` line, surface the
error to the user verbatim and suggest one of:

- Re-run with a more specific task description
- Check \`auggie account status\` in a separate shell
- Inspect \`.pi/traces/\` or run \`/skill:trace-report <name>\` to see
  what the sub-agent did before failing

Do not silently retry, do not fall back to inline work without
telling the user, and do not re-delegate the same task to a
different skill without explaining why.
`;

/**
 * Minimal `before_agent_start` event shape we depend on. We type this
 * narrowly so this module has no compile-time dependency on the full
 * `@earendil-works/pi-coding-agent` package (which is a peer).
 */
export interface BeforeAgentStartEventLike {
  type: "before_agent_start";
  systemPrompt: string;
}

export interface ExtensionAPI {
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEventLike) => Promise<{ systemPrompt: string } | void> | { systemPrompt: string } | void
  ): void;
}

/**
 * Append the versioned prompt block to a system prompt string. Pure
 * function — exported for testing and for callers that already have
 * the system prompt in hand.
 */
export function appendAgentPromptBlock(systemPrompt: string): string {
  return `${systemPrompt}\n\n${AGENT_PROMPT_BLOCK}`;
}

/**
 * Read the package version from the nearest package.json. Best effort —
 * returns `"unknown"` if the file can't be located or parsed. Tries
 * `../package.json` (compiled `dist/agentPrompt.js` → root), then
 * `../../package.json` (compiled from a nested location).
 */
export function readPackageVersion(): string {
  const candidates: string[] = [];
  if (typeof __dirname !== "undefined") {
    candidates.push(join(__dirname, "..", "package.json"));
    candidates.push(join(__dirname, "..", "..", "package.json"));
    candidates.push(join(__dirname, "..", "..", "..", "package.json"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "pi-auggie-router" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // ignore and try next candidate
      }
    }
  }
  return "unknown";
}

/**
 * Tracks which `ExtensionAPI` instances already have the hook installed,
 * so a duplicate `installAgentPromptInjection(pi)` call is a no-op rather
 * than registering a second listener (which would append the block twice).
 * A `WeakSet` lets the pi instance be GC'd without leaking.
 */
const INSTALLED_ON = new WeakSet<ExtensionAPI>();

/**
 * Install the `before_agent_start` hook that appends the versioned
 * prompt block to every system prompt. Idempotent per `pi` instance:
 * repeated calls with the same `pi` register exactly one listener.
 *
 * The handler is robust to both event-mutation and return-value
 * conventions: it mutates `event.systemPrompt` in place **and** returns
 * `{ systemPrompt }`, so the block lands regardless of which contract
 * the host honors.
 *
 * If the supplied `pi` object does not expose `.on(...)` (older
 * extension bridge without lifecycle events), the call is a no-op and
 * a warning is logged via the optional `log` callback.
 *
 * @param pi   The Pi `ExtensionAPI` instance.
 * @param log  Optional logger (`host.log` from the PiHost contract).
 */
export function installAgentPromptInjection(
  pi: ExtensionAPI,
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void
): void {
  if (typeof pi?.on !== "function") {
    log?.(
      "warn",
      "pi-auggie-router: ExtensionAPI.on() not available; system-prompt injection skipped. Update @earendil-works/pi-coding-agent to >=0.74.0."
    );
    return;
  }
  if (INSTALLED_ON.has(pi)) {
    log?.("debug", "pi-auggie-router: system-prompt injection already installed; skipping duplicate.");
    return;
  }
  INSTALLED_ON.add(pi);
  const version = readPackageVersion();
  pi.on("before_agent_start", (event) => {
    if (!event || typeof event.systemPrompt !== "string") return;
    const systemPrompt = appendAgentPromptBlock(event.systemPrompt);
    // Cover both host conventions: in-place mutation and return value.
    event.systemPrompt = systemPrompt;
    return { systemPrompt };
  });
  log?.("info", `pi-auggie-router v${version}: installed system-prompt injection hook`);
}
