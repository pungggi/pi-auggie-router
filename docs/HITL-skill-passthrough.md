# Dual-mode skill invocation: HITL in-context + router sub-agents

**Status:** Implemented (Phases 1–4: B + A + C + D + prompt/docs) — unreleased, targets v1.5.0  
**Date:** 2026-08-01  
**Package:** `pi-auggie-router`  
**Related code:** `src/index.ts` (`onUserInput` intercept), `src/parser.ts` (`matchSkillCommand`, `matchLocalSkillCommand`, `locateSkillFile`, `parseSkillFile`, `isLocalExecution`), `src/types.ts` (`ParsedSkill`, `SkillPassthroughSettings`, `PiHost.listSkillRoots`), `src/config.ts` (`skillPassthrough`), `src/agentPrompt.ts` (`AGENT_PROMPT_BLOCK`), `src/extensionBridge.ts` (`listSkillRoots`)  
**Trigger:** Importing interactive Agent Skills (e.g. mattpocock `wayfinder`, `setup-matt-pocock-skills`, `grilling`) that must run in the main agent session, while keeping `/skill:<name>` router delegation for AFK/coding skills.

---

## 1. Problem

Today the router owns **every** `/skill:<name>` keystroke:

```
onUserInput
  → match /^\/skill:([a-zA-Z0-9_-]+)\b/
  → always return { cancel: true }        // Pi's built-in skill loader never runs
  → loadSkill() from ONLY two paths
       .pi/skills/<name>/SKILL.md
       ~/.pi/agent/skills/<name>/SKILL.md
  → spawn isolated sub-agent (Auggie semantic retrieval, no live Q&A)
```

That design is correct for **AFK / coding** skills (`refactor`, `test`, `explain`, `research`):
bounded task → brief → isolated sub-agent → sanitized answer back to main chat.

It is wrong for **HITL / manual** skills (`wayfinder`, `setup-matt-pocock-skills`, `grilling`, `domain-modeling`, `prototype`):

| HITL need | Router reality |
| --- | --- |
| Multi-turn Q&A with the human in the same session | Q&A fallback is broken / times out (`agentPrompt` bridge limitation #2) |
| Agent reads companion files next to `SKILL.md` (`LOGIC.md`, issue-tracker templates, …) | Sub-agent is steered to Augment `codebase-retrieval` only |
| State lives in the main conversation | Sub-agent is isolated; tool traces stripped |
| Skill may live under `~/.claude/skills` (pi `settings.skills`) | `locateSkillFile` ignores `settings.skills` → `Skill "…" not found.` |

Net effect for the user: typing `/skill:setup-matt-pocock-skills` either shows a one-line “not found” system message, or (if relocated into the two hard-coded dirs) starts a sub-agent that cannot actually run the skill. The only reliable path today is natural language + main-agent `read` of `SKILL.md` — which works, but loses the explicit slash-command UX and collides with the agent prompt that says “prefer `/skill <name>` delegation.”

**Goal:** keep the router for skills that belong in a sub-agent, **and** make it possible to invoke HITL / manual skills via slash command so Pi’s built-in in-context loader runs them.

---

## 2. Two skill populations

| Kind | Examples | Correct host | Correct UX |
| --- | --- | --- | --- |
| **Routed** (AFK / coding) | `refactor`, `test`, `explain`, `research` | Isolated sub-agent via router | `/skill:<name> <task…>` → brief → execute → answer |
| **Local / HITL** (manual) | `wayfinder`, `setup-matt-pocock-skills`, `grilling`, `domain-modeling`, `prototype`, `grill-me` | Main agent session (Pi built-in skill loader) | `/skill:<name>` → load `SKILL.md` into main context → interactive loop |

These are not the same product surface. Forcing both through one execution path is the bug.

---

## 3. Requirements

1. **R1 — Local invoke:** User can force a skill to run **in the main session** (Pi default skill handler), including skills under any path in pi’s `settings.skills` (e.g. `~/.claude/skills`).
2. **R2 — Router unchanged for AFK skills:** Existing `/skill:<name> <task>` flows keep Actor/Judge, adaptive model routing, Auggie retrieval, sanitizer, traces.
3. **R3 — No silent swallow:** A `/skill:` that the router will not own must either passthrough to Pi or show a clear error. Never `{ cancel: true }` + “not found” when Pi could have handled it.
4. **R4 — Explicit + automatic classification:** Support both an escape-hatch command the user/agent can type, and automatic detection from `SKILL.md` frontmatter / location so HITL skills “just work.”
5. **R5 — Backwards compatible default:** Skills that today resolve under the two hard-coded dirs and have no opt-out keep being routed. No surprise behaviour change for current AFK skills.
6. **R6 — Agent prompt honesty:** The injected `AGENT_PROMPT_BLOCK` must describe both modes so the main agent stops treating colon-form as “falls through as plain text” and stops routing HITL work into the sub-agent path.

---

## 4. Design options (evaluated)

### Option A — Dual prefix (escape hatch only)

| Command | Owner |
| --- | --- |
| `/skill:<name> …` | Router (current behaviour) |
| `/skill-local:<name>` or `/skill!:<name>` | Passthrough → Pi built-in |

- **Pros:** Tiny change; zero risk to AFK path; explicit.
- **Cons:** HITL skills still “not found” / swallowed on the normal `/skill:` prefix unless the user remembers the escape hatch. Agent must be taught a second syntax.

### Option B — Fall through on not-found (minimal fix)

In `onUserInput`, only `{ cancel: true }` **after** a successful `loadSkill`. On `SkillNotFoundError`, return without cancel so Pi’s default handler runs (it already searches `settings.skills`, including `~/.claude/skills`).

- **Pros:** One-file change; fixes the “nothing happens / not found” case immediately; R3 + most of R1.
- **Cons:** Skills that *are* in `~/.pi/agent/skills/` but are HITL still get sub-agent execution. Does not solve classification, only discovery gap.

### Option C — Frontmatter opt-out / opt-in

Extend `parseSkillFile` to read execution mode from frontmatter, e.g.:

```yaml
# Opt out of router (run in main session)
router: false
# — or —
execution: in-context   # in-context | subagent
# — or reuse Agent Skills standard field as a signal —
disable-model-invocation: true
```

When mode is local → do not cancel; let Pi load the skill in-context.  
When mode is subagent (default for found skills) → current path.

- **Pros:** Skill author declares intent once; no new user syntax; maps cleanly onto existing `disable-model-invocation: true` on wayfinder/setup.
- **Cons:** Requires the skill file to be locatable first (so still needs B and/or expanded search paths). Authors of older skills need a one-line frontmatter add (or we treat `disable-model-invocation: true` as the default local signal).

### Option D — Expand `locateSkillFile` to pi skill roots

Also search every directory from pi’s skill discovery (workspace `.pi/skills`, `~/.pi/agent/skills`, `settings.skills` entries like `~/.claude/skills`, package skills). Router can then *see* HITL skills — but must combine with C so seeing ≠ always routing.

- **Pros:** Single source of truth for “where skills live”; aligns router with pi.
- **Cons:** Alone this makes HITL worse (more skills get force-routed into sub-agents). Must ship with C.

### Option E — Syntax split by args

- `/skill:<name>` with **empty remainder** → local (Pi)
- `/skill:<name> <task…>` with remainder → router

- **Pros:** No frontmatter; matches “picker vs task” intuition.
- **Cons:** Ambiguous for AFK skills that are often invoked with just a path as the “task”; breaks muscle memory; HITL skills sometimes take an argument (`/skill:wayfinder map #42`).

### Verdict

**Ship B + C as the core, A as an explicit escape hatch, D as a follow-up.**  
E is rejected (too ambiguous).

```
Recommended stack
─────────────────
1. B  Fall through when router cannot load the skill          ← fixes “not found”
2. C  Frontmatter / disable-model-invocation → local mode     ← fixes HITL when found
3. A  /skill-local:<name> (or /skill!:<name>) always local    ← explicit override
4. D  Expand search paths to settings.skills                  ← parity with pi discovery
5.    Update AGENT_PROMPT_BLOCK + README                      ← agent + human docs
```

---

## 5. Proposed behaviour (target)

### 5.1 Decision table

| User input | Skill location | Frontmatter | Result |
| --- | --- | --- | --- |
| `/skill-local:foo` / `/skill!:foo` | anywhere Pi can see | any | **Local** — do not cancel; Pi built-in loads `SKILL.md` in main session |
| `/skill:foo` | not in any router-visible path | — | **Passthrough** — do not cancel; Pi built-in may still find it via `settings.skills` |
| `/skill:foo` | found | `router: false` **or** `execution: in-context` **or** `disable-model-invocation: true` | **Local** — do not cancel; optionally post a one-line `[System]: Running /skill:foo in-session (HITL).` |
| `/skill:foo …` | found | no opt-out (default) | **Routed** — current sub-agent pipeline |
| `/skill:trace-report` / `trace-view` | — | — | unchanged observability commands |

### 5.2 Frontmatter contract

Add to the skill author surface (document in README):

```yaml
---
name: wayfinder
description: …
disable-model-invocation: true   # Agent Skills standard — ALSO treated as local/HITL by the router
# optional explicit forms (either is enough):
router: false
execution: in-context            # in-context | subagent
---
```

Precedence when loading for the router:

1. `execution: in-context` → local  
2. `execution: subagent` → routed (even if `disable-model-invocation: true`)  
3. `router: false` → local; `router: true` → routed  
4. `disable-model-invocation: true` → local (safe default for “user must invoke” skills)  
5. else → routed (today’s default)

`execution: subagent` is the escape for the rare skill that is both `disable-model-invocation: true` *and* meant for the router (e.g. a dangerous AFK skill you only want via explicit slash).

### 5.3 Intercept rewrite (conceptual)

Current (`src/index.ts`):

```ts
const match = matchSkillCommand(raw);
if (!match) return;
void handleSkillCommand(match.name);
return { cancel: true };   // always
```

Target:

```ts
// 1) Explicit local escape hatch — never claim it.
const local = matchLocalSkillCommand(raw); // /^\/skill-local:…/ or /^\/skill!:…/
if (local) return; // no cancel → Pi built-in runs

// 2) Observability subcommands — unchanged, cancel + handle.

// 3) Standard /skill:name
const match = matchSkillCommand(raw);
if (!match) return;

let skill: ParsedSkill;
try {
  skill = loadSkill(host, match.name);
} catch (err) {
  if (err instanceof SkillNotFoundError) {
    // R3: let Pi try settings.skills / other roots
    return; // no cancel
  }
  host.postSystemMessage(`[System]: ${err.message}`);
  return { cancel: true };
}

if (isLocalExecution(skill)) {
  // HITL / manual — do not cancel; Pi in-context loader runs
  host.postSystemMessage?.(
    `[System]: /skill:${skill.name} → in-session (HITL). Router skipped.`
  );
  return; // no cancel
}

// AFK / coding — claim it
void handleSkillCommandFromParsed(skill, match.remainder);
return { cancel: true };
```

`isLocalExecution(skill)` implements the precedence in §5.2.  
`parseSkillFile` must surface the new fields on `ParsedSkill` (`execution`, `router`, `disableModelInvocation`).

### 5.4 Search path expansion (step D)

`locateSkillFile` today:

```ts
const candidates = [
  host.resolveWorkspacePath(join(".pi", "skills", skillName, "SKILL.md")),
  host.resolveHomePath(join(".pi", "agent", "skills", skillName, "SKILL.md")),
];
```

Target order (first hit wins):

1. `<workspace>/.pi/skills/<name>/SKILL.md`
2. `~/.pi/agent/skills/<name>/SKILL.md`
3. Each entry in pi `settings.skills` (files or directories), resolved the same way Pi core does — including `~/.claude/skills/<name>/SKILL.md` and package-contributed skills if the host exposes them
4. (Optional) `~/.agents/skills/<name>/SKILL.md` for Agent Skills standard parity

Host may need a new optional API, e.g. `host.listSkillRoots(): string[]`, so the router does not re-implement pi’s discovery. If the host cannot list roots yet, ship B+C+A first and keep D behind a small host capability check.

### 5.5 Agent prompt (`AGENT_PROMPT_BLOCK`)

Replace the absolute “never use colon form / it falls through as plain text” guidance with dual-mode rules:

```text
### Skill invocation (two modes)

1. Routed (AFK / coding) — router owns it:
     /skill <name> <task description>
     /skill:<name> <task description>
   Spawns an isolated sub-agent (Auggie retrieval, sanitized answer).
   Use for refactor, test, explain, research, and similar.

2. In-session (HITL / manual) — main agent owns it:
     /skill-local:<name> …     (always)
     /skill:<name>             when the skill opts out via frontmatter
                               (disable-model-invocation: true | router: false |
                                execution: in-context)
   Pi loads SKILL.md into THIS session. You then follow it interactively.
   Use for wayfinder, grilling, setup-*, domain-modeling, prototype, grill-me.

Rules:
- Prefer routed mode for bounded coding tasks with a clear deliverable.
- Prefer in-session mode when the skill needs multi-turn human answers,
  companion files next to SKILL.md, or writes decisions into the live chat.
- If unsure, use /skill-local:<name> for interactive skills; never delegate
  HITL skills to the routed sub-agent path.
- Do not pre-read a skill’s target files before a ROUTED invocation.
  DO read SKILL.md (and its relative companions) for an IN-SESSION invocation.
```

Also drop the incorrect claim that colon form is never intercepted — it is intercepted today, and after this change it is intercepted **only when the skill is routed**.

---

## 6. Worked examples

### 6.1 HITL setup skill under `~/.claude/skills`

```
User:  /skill:setup-matt-pocock-skills
```

1. Regex matches `setup-matt-pocock-skills`.
2. `locateSkillFile` — with D: finds `~/.claude/skills/setup-matt-pocock-skills/SKILL.md`. Without D: not found → passthrough (B).
3. Frontmatter has `disable-model-invocation: true` → `isLocalExecution` true (C).
4. Router returns without cancel. Pi built-in loads the skill into the main session.
5. Main agent runs the section-by-section Q&A wizard against the live user.

### 6.2 AFK research skill

```
User:  /skill:research What does the GitHub Projects V2 API return for draft issues?
```

1. Match + locate (e.g. `~/.pi/agent/skills/research/SKILL.md` or via D).
2. No local opt-out → routed.
3. Actor/Judge brief → sub-agent with Auggie → sanitized findings in main chat.
4. Unchanged from today.

### 6.3 Explicit override

```
User:  /skill-local:research   # force in-session even if research is routable
User:  /skill!:grilling        # same
```

Router never cancels; Pi loads in-session. Useful when debugging a skill or when the user wants the main model to drive an otherwise-routable skill.

### 6.4 Skill only in `~/.claude/skills`, no frontmatter opt-out

```
User:  /skill:my-custom-thing do the thing
```

- Without D: not found in two dirs → passthrough → Pi finds it via `settings.skills` → in-session.  
- With D + no opt-out: router finds it → **routes** to sub-agent.  
  → Authors of interactive skills living only under `~/.claude/skills` should set `router: false` or `disable-model-invocation: true` once D lands. Document this migration note in the CHANGELOG.

---

## 7. Implementation plan

### Phase 1 — Stop the bleeding (B + A)  ~small PR

| Change | File |
| --- | --- |
| Match `/skill-local:` and `/skill!:` and **never** cancel | `src/parser.ts`, `src/index.ts` |
| On `SkillNotFoundError`, return without cancel (passthrough) | `src/index.ts` `onUserInput` |
| Tests: not-found passthrough; local prefix passthrough; existing routed happy path still cancels | `tests/` |
| README + this doc: document `/skill-local:` | `README.md` |

**Acceptance:**  
- `/skill:setup-matt-pocock-skills` with skill only in `~/.claude/skills` → Pi in-session runs it (no “not found”).  
- `/skill:refactor …` with skill in `~/.pi/agent/skills` → still routed.

### Phase 2 — Classification (C)  ~small PR

| Change | File |
| --- | --- |
| Parse `router`, `execution`, `disable-model-invocation` into `ParsedSkill` | `src/parser.ts`, `src/types.ts` |
| `isLocalExecution(skill)` + skip cancel when true | `src/index.ts` |
| Optional one-line system marker for local handoff | `src/index.ts` |
| Tests for each precedence branch (§5.2) | `tests/` |
| README “Skill authoring: routed vs in-session” section | `README.md` |

**Acceptance:**  
- Skill in `~/.pi/agent/skills/grilling` with `disable-model-invocation: true` → in-session.  
- Same skill with `execution: subagent` → routed.  
- Skill without flags → routed (compat).

### Phase 3 — Discovery parity (D)  ~medium PR

| Change | File |
| --- | --- |
| `host.listSkillRoots?.(): string[]` (optional) or read settings via existing host hooks | `src/types.ts`, `extension.ts` / bridge |
| `locateSkillFile` walks roots in §5.4 order | `src/parser.ts` |
| CHANGELOG migration note for `~/.claude/skills` authors (add opt-out if HITL) | `CHANGELOG.md` |

**Acceptance:** Router can load and classify skills from `settings.skills` the same way Pi lists them.

### Phase 4 — Prompt + docs honesty

| Change | File |
| --- | --- |
| Rewrite dual-mode block (§5.5) | `src/agentPrompt.ts` |
| README execution-flow diagram gains a “local?” branch before “cancel” | `README.md` |
| Mark this doc **Implemented** with version pins | `docs/HITL-skill-passthrough.md` |

---

## 8. Execution-flow (target)

```
user types /skill… 
        │
        ├─ /skill-local: or /skill!: ──────────────► Pi built-in (in-session)     [A]
        │
        ├─ /skill:trace-report|trace-view ─────────► observability (cancel)
        │
        └─ /skill:<name>
                │
                loadSkill
                │
                ├─ not found ──────────────────────► Pi built-in passthrough      [B]
                │
                ├─ isLocalExecution? ──────────────► Pi built-in (in-session)     [C]
                │
                └─ else ───────────────────────────► Actor/Judge → sub-agent
                                                      (today’s routed path)
```

Compare to today’s flow in README “Execution flow” step 1: *always* cancel on match. That single branch is what this design splits.

---

## 9. Non-goals

- Replacing Pi’s built-in skill loader. Local mode **is** that loader; the router only gets out of the way.
- Fixing the broken sub-agent Q&A fallback. HITL skills should not use it; they go in-session instead.
- Teaching the sub-agent to read arbitrary companion files next to `SKILL.md`. Out of scope; local mode already has full filesystem tools in the main session.
- Auto-detecting HITL from skill *body* prose (“ask one question at a time”). Frontmatter only — predictable, testable.
- Changing the space-form `/skill <name>` agent-delegation story beyond updating the prompt so both modes are described accurately.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| AFK skill accidentally opted out via `disable-model-invocation: true` | Document precedence; allow `execution: subagent` override; default remains routed when flag absent |
| After D, HITL skills under `~/.claude/skills` start getting routed | CHANGELOG migration: add `router: false` (or rely on existing `disable-model-invocation: true`, which C already treats as local) |
| User confuses “not found” silence with passthrough failure | If Pi also cannot find the skill, Pi shows its own error; optional router log line at debug level when passthrough happens |
| Agent keeps delegating HITL skills into the router | Phase 4 prompt rewrite; main agent taught `/skill-local:` for interactive skills |
| Double-execution (router + Pi both run) | Local path must **not** call `handleSkillCommand`; routed path must **cancel**. Tests for mutual exclusion |

---

## 11. Workaround until this ships

While the router still always claims `/skill:`:

1. **Disable the router package** (remove `npm:pi-auggie-router` from `~/.pi/agent/settings.json` → `packages`, restart pi). Pi’s built-in `/skill:<name>` then loads any skill from `settings.skills` in-session. AFK sub-agent delegation is unavailable until re-enabled.
2. **Or keep the router** and invoke HITL skills by natural language (“run the setup-matt-pocock-skills skill”, “start wayfinder on …”). The main agent `read`s `SKILL.md` and follows it interactively. Do **not** type `/skill:<hitl-name>` — the router will intercept and fail or mis-run it.
3. **Or** copy only AFK skills into `~/.pi/agent/skills/` for routed use, and keep HITL skills solely under `~/.claude/skills` for natural-language / post-fix local use.

This document is the path back to “both at once” without that compromise.

---

## 12. Acceptance checklist (definition of done)

- [x] `/skill-local:setup-matt-pocock-skills` runs in-session with router installed — escape hatch never cancels (`matchLocalSkillCommand`)  
- [x] `/skill:setup-matt-pocock-skills` (skill only under `~/.claude/skills`, `disable-model-invocation: true`) runs in-session — not-found passthrough (B) or discovery (D) + classification (C); no "not found", no sub-agent  
- [x] `/skill:research <question>` still routes to sub-agent with traces/sanitizer — default routed when no opt-out  
- [x] `/skill:missing-skill-xyz` does not hard-cancel if Pi might resolve it; no stuck "Router busy" — `SkillNotFoundError` → no cancel  
- [x] `execution: subagent` forces route even when `disable-model-invocation: true` — precedence rule #2 in `isLocalExecution`  
- [x] `AGENT_PROMPT_BLOCK` describes both modes; no "colon form falls through as plain text" claim — rewritten in `src/agentPrompt.ts`  
- [x] README execution-flow updated; CHANGELOG entry; tests for B/C/A branches green — `tests/router.test.ts` (dual-mode suite) + `tests/parser.test.ts` + `tests/agentPrompt.test.ts`

### Implementation notes (divergences from the original proposal)

- **`router.trigger()` is a force-route surface.** It bypasses classification and always routes (space-form `/skill <name>` semantics, per §13 Q4). A not-found skill reached via `trigger` surfaces an error directly, because there is no Pi built-in fallback on the programmatic path. The chat input intercept (`onUserInput`) is the only path that does passthrough.
- **`listSkillRoots` is optional + bridge-backed.** `PiHost.listSkillRoots?: () => string[]` is optional; the extension bridge implements it by reading pi's global + project `settings.json` `skills` arrays (with `~` expansion). Hosts without the method keep the original two-dir behaviour (B still gives the right outcome via passthrough).
- **`surfaceLocalHandoff` lives under `auggieRouter.skillPassthrough`** (not `router.surfaceLocalHandoff`), matching the existing nested-settings convention. Default `true`.

---

## 13. Open questions

1. **Escape-hatch spelling:** `/skill-local:` vs `/skill!:` vs `/skill/local:` — recommend supporting **both** `/skill-local:` and `/skill!:` (same handler).  
2. **Host API for skill roots:** Does pi expose skill roots to extensions today, or does Phase 3 need a pi core change first? If yes, gate D on that version.  
3. **System marker noise:** Is the one-line `[System]: … in-session (HITL)` useful or spammy? Default on; setting `router.surfaceLocalHandoff: false` to hide.  
4. **Space-form `/skill name`:** Today the agent prompt pushes space-form for routed work. Keep it as pure agent-emitted syntax that the bridge maps to the same routed path; do not require users to learn space-form. Users keep typing `/skill:name`.

---

## 14. Summary

The router should stop being a totalitarian owner of `/skill:`. It should be a **classifier + executor for routed skills**, and a **passthrough for local/HITL skills**:

- **Passthrough when** not found, opted out via frontmatter, or explicit `/skill-local:` / `/skill!:`.  
- **Route when** found and not opted out (today’s default).  

That restores manual/HITL slash invocation (Pi in-session) without giving up the router for AFK coding skills.
