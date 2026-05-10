# Context Management Action Plans for `pi-auggie-router`

**Status:** Draft  
**Date:** 2026-05-10  
**Package:** `pi-auggie-router`  
**Source inspiration:** Sally-Ann Delucia, *Hierarchical Memory: Context Management in Agents*  

## 1. Purpose

This document breaks the context-management improvement ideas into independent implementation plans. Each action can be estimated, prioritized, implemented, and shipped separately.

The common theme is:

> Context decides what the model sees. Memory decides what survives.

`pi-auggie-router` already has a strong context-isolation architecture: a main Pi thread, a cheap Actor/Judge planning loop, and isolated skill sub-agents that must retrieve code context through Auggie's `codebase-retrieval` MCP tool. The plans below focus on making that architecture more robust for large retrieval payloads, long sessions, prompt-cache efficiency, and complex skill workflows.

## 2. Current Baseline

Relevant current behavior:

- `/skill:<name>` is intercepted in `src/index.ts`.
- `runActorJudgeLoop(...)` builds a structured brief from recent chat history.
- `historyWindow` defaults to `20` and is read through `host.getRecentMessages(...)`.
- `executeSkill(...)` in `src/subAgent.ts` runs an isolated sub-agent with:
  - skill instructions,
  - `AUGGIE_DIRECTIVE`,
  - optional system appendix,
  - the rendered Actor/Judge brief as user prompt,
  - Auggie MCP attached.
- `makeOverflowMiddleware(...)` in `src/auggie.ts` blocks oversized `codebase-retrieval` results and replaces them with:

  ```text
  Result too large. Please refine your codebase-retrieval query to be more specific.
  ```

- Adaptive execution routing already classifies work by complexity and risk, but that classification currently selects only the model, not the context budget.

---

# Action 1 — Overflow Context Memory

## Summary

When `codebase-retrieval` returns a payload above `overflowCeilingBytes`, do not discard it completely. Store the blocked payload in a short-lived overflow memory store and return a small handle to the sub-agent so it can request slices or previews later.

## Problem

Today, an oversized retrieval result is lost. The sub-agent is told to refine the query, but if the first result contained useful hard-to-recover context, the model has no memory handle for it.

This is equivalent to truncation without memory.

## Goal

Turn overflow handling from:

```text
large result -> dropped -> retry from scratch
```

into:

```text
large result -> stored -> compact handle returned -> sub-agent can retrieve targeted slices
```

## Non-goals

- Do not persist long-term user memory.
- Do not store data beyond the active skill execution by default.
- Do not expose overflow payloads to the main Pi thread.
- Do not bypass the existing Auggie-first retrieval policy.

## Proposed Design

### 1. Add an execution-scoped memory store

Create a small helper, for example:

```text
src/contextMemory.ts
```

Core responsibilities:

- Generate stable IDs such as `overflow_1`, `overflow_2`.
- Store:
  - raw payload text,
  - byte length,
  - timestamp,
  - server name,
  - tool name,
  - optionally a redacted query preview if available in middleware context.
- Enforce limits:
  - maximum entries per skill execution,
  - maximum bytes per execution,
  - TTL cleanup after sub-agent completion.

### 2. Replace overflow text with a memory handle

Instead of returning only:

```text
Result too large. Please refine your codebase-retrieval query to be more specific.
```

return something like:

```text
Result too large and was stored as overflow_1.
Size: 187432 bytes.
Preview: <first N chars> ... <last N chars>
Use the context-memory tool to inspect slices only if needed; otherwise refine your codebase-retrieval query.
```

The preview should be head/tail, not a naive first-only truncation.

### 3. Add a retrieval surface for the sub-agent

Implemented via a tiny stdio MCP server (`context-memory`) that reads from the
execution-scoped temp directory created by `ContextMemoryStore`. The sub-agent
can call `context-memory.read` for slices and `context-memory.list` for metadata.

The read tool supports:

```json
{
  "id": "overflow_1",
  "offset": 0,
  "limit": 8000
}
```

Additional operations:

- `context-memory.list` — show available overflow IDs and metadata.
- Future: `search` — exact substring search within a stored payload.

### 4. Cleanup

`executeSkill(...)` creates the memory store before composing middleware, attaches
the companion `context-memory` MCP server to the sub-agent, and disposes the store
after `host.runSubAgent(...)` resolves or rejects.

## Files Likely Touched

- `src/auggie.ts`
- `src/subAgent.ts`
- `src/types.ts`
- New: `src/contextMemory.ts`
- Possibly `src/extensionBridge.ts` if the extension bridge must pass through a synthetic MCP server.
- Tests under `tests/`.

## Configuration

Add optional settings under `auggieRouter`, for example:

```json
{
  "contextMemory": {
    "enabled": true,
    "maxEntries": 8,
    "maxBytesPerRun": 1000000,
    "previewHeadChars": 4000,
    "previewTailChars": 4000
  }
}
```

Default recommendation:

- `enabled: false` for first release if tool plumbing is risky.
- Or `enabled: true` if fully execution-scoped and well-tested.

## Acceptance Criteria

- Oversized Auggie results are stored execution-locally instead of discarded.
- Replacement message includes an ID, byte size, and bounded head/tail preview.
- Sub-agent can retrieve a bounded slice by ID.
- Memory is unavailable after the skill execution completes.
- Limits prevent unbounded RAM growth.
- Existing overflow behavior remains available when memory is disabled.

## Tests

- Stores oversized Auggie result and returns a handle.
- Does not store non-Auggie tool results.
- Does not store Auggie results under the ceiling.
- Enforces max entries.
- Enforces max bytes per run.
- Returns bounded slices.
- Cleans up after execution.
- Redacts secrets if metadata or previews are surfaced in system messages/logs.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Memory store accidentally becomes a raw context dump mechanism | Require offset/limit; cap slice size; keep Auggie refinement directive. |
| Sensitive data retained longer than expected | Execution-scoped store, cleanup in `finally`, no disk persistence by default. |
| More tools confuse the sub-agent | Keep tool description narrow: use only for overflow handles. |
| Provider context still blows up if slices are too large | Hard cap slice size below `overflowCeilingBytes`. |

## Suggested Milestones

1. Implement `ContextMemoryStore` with unit tests.
2. Modify `makeOverflowMiddleware(...)` to optionally store and return handles.
3. Add a sub-agent-accessible `context-memory` tool.
4. Wire cleanup into `executeSkill(...)`.
5. Document settings and safety behavior.

---

# Action 2 — Long-Session Evaluation Fixtures

## Summary

Add a test suite that simulates long Pi conversations and verifies that `/skill` routing quality does not degrade after many turns.

## Problem

Long conversations often fail late. The current router has unit tests for routing behavior, but no dedicated regression harness that models 10, 20, or 30 turns of mixed normal chat and `/skill` usage.

## Goal

Make context degradation testable before users report failures.

## Non-goals

- Do not require real LLM calls in normal CI.
- Do not evaluate subjective final-answer quality in MVP.
- Do not replace existing unit tests.

## Proposed Design

### 1. Create long-session fixtures

Add fixtures such as:

```text
tests/fixtures/long-session/basic-10-turns.json
tests/fixtures/long-session/large-history-20-turns.json
tests/fixtures/long-session/skill-followup-20-turns.json
```

Each fixture should include:

- ordered chat messages,
- the `/skill:<name>` command to run,
- expected brief fields,
- expected minimum route tier,
- expected pass/fail status.

### 2. Build a fake `PiHost`

Create a deterministic host that:

- returns fixture messages from `getRecentMessages(...)`,
- returns canned Actor/Judge JSON from `callLLM(...)`,
- records system/assistant messages,
- does not run a real sub-agent unless explicitly requested.

### 3. Test the 11th-turn pattern

Following the talk's recommendation:

- load 10 turns,
- test the 11th,
- repeat for 20+ turns.

Useful scenarios:

1. Original goal appears early, follow-up appears late.
2. Skill command references something discussed 15 turns ago.
3. History contains huge messages that must be truncated safely.
4. Clarification Q&A happens after a long history.
5. Adaptive routing stays stable despite irrelevant middle chatter.

### 4. Add quality metrics as assertions

Initial deterministic metrics:

- Actor output is parseable JSON.
- Judge output is parseable JSON.
- Brief contains non-empty `userGoal`.
- Brief contains expected keywords.
- `knownContext` does not exceed a configured character limit.
- Judge confidence does not fall below threshold for known-good fixture.
- The selected route tier matches expected safety floors.

## Files Likely Touched

- New: `tests/longSession.test.ts`
- New: `tests/fixtures/long-session/*.json`
- Possibly shared test helpers under `tests/helpers/`.

## Configuration

No production configuration required.

Optional dev-only environment variable:

```text
RUN_LIVE_LONG_SESSION_EVALS=1
```

This could enable a separate non-CI live eval suite later.

## Acceptance Criteria

- CI runs deterministic long-session tests without external LLM calls.
- At least one fixture tests the 10-turn + 11th-turn pattern.
- At least one fixture tests 20+ turns.
- Failures clearly identify whether the issue is history assembly, Actor output, Judge output, or execution routing.

## Tests

The action itself is a test suite. It should include fixtures for:

- read-only skill after long chat,
- small edit after long chat,
- ambiguous command requiring Q&A,
- large chat messages near truncation limits,
- adaptive routing route stability.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Fake LLM responses do not catch real degradation | Add optional live evals outside normal CI. |
| Fixtures become brittle | Assert semantic fields and route classes, not exact full prompts. |
| Test suite duplicates router unit tests | Focus only on multi-turn history effects. |

## Suggested Milestones

1. Add fake host helper.
2. Add 10-turn and 20-turn fixtures.
3. Assert Actor/Judge and routing outputs.
4. Add optional live eval harness separately.

---

# Action 3 — Head/Tail Chat History Assembly

## Summary

Replace simple recent-message selection for Actor/Judge context with a budgeted head/tail strategy: keep the earliest task-setting messages, keep the latest messages, and compress or omit the middle.

## Problem

`host.getRecentMessages(settings.historyWindow)` gives the Actor/Judge the last N messages. In long sessions, important original context may fall out of the window. If `historyWindow` is increased, Actor/Judge prompts can become noisy, costly, and less cache-friendly.

## Goal

Improve brief quality in long conversations while keeping routing prompts bounded.

## Non-goals

- Do not add long-term memory in this action.
- Do not change sub-agent retrieval policy.
- Do not summarize code retrieval payloads.

## Proposed Design

### 1. Add a history assembler

Create:

```text
src/historyAssembler.ts
```

Input:

- raw `ChatMessage[]`,
- settings,
- optional current skill name.

Output:

- assembled `ChatMessage[]` or a structured history block consumed by `buildActorMessages(...)`.

### 2. Use head/tail budgeting

Example default policy:

- Keep first `historyHeadMessages = 2` messages from the available window.
- Keep last `historyTailMessages = 12` messages.
- Middle messages are either:
  - omitted with a marker, or
  - compressed into a short deterministic extract.

Important: because the host currently exposes only `getRecentMessages(count)`, true session head may not be available from all hosts. The first implementation can use head/tail within the retrieved window. A later host API could expose full session history or session-start messages.

### 3. Avoid naive summarization as the primary strategy

The talk warns that general LLM summarization is inconsistent. MVP should prefer deterministic compression:

- role counts,
- timestamps/order if available,
- skill commands seen,
- filenames or explicit paths mentioned,
- user clarification answers,
- first/last N chars per important message.

Optional LLM summarization can be a later experimental mode.

### 4. Add settings

Example:

```json
{
  "historyStrategy": "recent",
  "historyHeadMessages": 2,
  "historyTailMessages": 12,
  "historyMiddleMode": "marker",
  "historyMaxCharsPerMessage": 10000,
  "historyMaxTotalChars": 60000
}
```

For backwards compatibility, default `historyStrategy` should initially be `recent`.

An opt-in strategy could be:

```json
{
  "historyStrategy": "headTail"
}
```

### 5. Wire into Actor/Judge

Modify `runActorJudgeLoop(...)`:

```ts
const rawHistory = host.getRecentMessages(settings.historyWindow);
const history = assembleHistory(rawHistory, settings);
```

## Files Likely Touched

- `src/actorJudge.ts`
- `src/config.ts`
- `src/types.ts`
- New: `src/historyAssembler.ts`
- Tests under `tests/`.
- README configuration docs.

## Acceptance Criteria

- Existing behavior remains default unless opted in.
- Head/tail strategy keeps bounded total characters.
- Middle omission is explicit, not silent.
- Actor/Judge prompts remain valid and parseable.
- Long-session fixtures show preserved early context when available.

## Tests

- Returns unchanged recent history for `historyStrategy: "recent"`.
- For `headTail`, keeps configured head and tail counts.
- Inserts a middle-omitted marker with count and approximate size.
- Enforces per-message char cap.
- Enforces total char cap.
- Handles short histories without duplicate messages.
- Handles empty history.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Host cannot provide true session head | Start with head/tail inside available window; document limitation. |
| Early irrelevant messages displace useful recent context | Keep tail larger than head; make counts configurable. |
| Middle compression loses key info | Include explicit marker and rely on Q&A fallback when needed. |
| More settings increase complexity | Hide behind one high-level `historyStrategy` first. |

## Suggested Milestones

1. Implement deterministic `assembleHistory(...)`.
2. Add config validation.
3. Wire into Actor/Judge behind opt-in setting.
4. Add tests and long-session fixture coverage.
5. Document in README.

---

# Action 4 — Context Budget by Execution Tier

## Summary

Use the Judge's `executionRoute` classification to choose context budgets, not only the execution model. Low-risk read-only work should receive smaller retrieval/history budgets; high-risk architecture work can receive larger budgets.

## Problem

`overflowCeilingBytes` is currently static. A simple read-only docs lookup and a high-risk architecture refactor get the same Auggie payload ceiling.

## Goal

Make context allocation proportional to task complexity and risk.

## Non-goals

- Do not change model routing policy itself.
- Do not allow unlimited payloads for frontier tasks.
- Do not expose route metadata inside the sub-agent system prompt if that would harm cache stability.

## Proposed Design

### 1. Add tier budget settings

Example:

```json
{
  "contextBudgets": {
    "enabled": false,
    "overflowCeilingBytes": {
      "cheap": 15000,
      "balanced": 25000,
      "frontier": 50000
    },
    "historyWindow": {
      "cheap": 10,
      "balanced": 20,
      "frontier": 30
    }
  }
}
```

Keep current top-level `overflowCeilingBytes` and `historyWindow` as defaults/fallbacks.

### 2. Compute effective settings per run

After Judge produces `executionRoute`, derive an execution-scoped effective context policy:

```ts
const effectiveContext = chooseContextBudget(settings, outcome.executionRoute);
```

Then use:

- effective history budget for final brief assembly if feasible,
- effective overflow ceiling in `executeSkill(...)`.

Caveat: the Actor/Judge loop needs history before it knows the route. Therefore, tier-based `historyWindow` can only apply after classification unless the route is known from a previous pass. For MVP, apply tier budget only to sub-agent overflow ceiling. Treat history budgets as a future extension.

### 3. Wire sub-agent overflow budget

Modify `executeSkill(...)` input to accept an optional effective overflow ceiling, or pass a derived settings object.

Do not mutate global settings.

### 4. Observability

Log effective context budget without logging user content:

```json
{
  "event": "auggie-router.context-budget",
  "skill": "refactor",
  "tier": "frontier",
  "overflowCeilingBytes": 50000
}
```

## Files Likely Touched

- `src/index.ts`
- `src/subAgent.ts`
- `src/config.ts`
- `src/types.ts`
- Possibly new: `src/contextBudget.ts`
- Tests under `tests/`.
- README docs.

## Acceptance Criteria

- Static behavior remains unchanged when `contextBudgets.enabled` is false.
- Effective overflow ceiling is selected by route tier when enabled.
- Safety floors still apply through existing execution route logic.
- Effective budget is sticky for the whole sub-agent run.
- Budget decision is logged without raw content.

## Tests

- Disabled context budgets use top-level `overflowCeilingBytes`.
- Cheap tier uses cheap ceiling.
- Balanced tier uses balanced ceiling.
- Frontier tier uses frontier ceiling.
- Missing tier value falls back to top-level default.
- Effective budget is passed to overflow middleware.
- Logs contain tier and numeric budget, not prompt/history content.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Larger frontier budget increases token/cost blowups | Keep hard upper validation limit; default to current ceiling. |
| Tier misclassification gives too little context | Allow `balanced` defaults; fallback message still asks model to refine query. |
| Prompt cache invalidation | Keep budget metadata out of system prompt. |

## Suggested Milestones

1. Implement `chooseContextBudget(...)` helper.
2. Add config and validation.
3. Pass effective overflow ceiling into `executeSkill(...)`.
4. Add structured logs.
5. Add tests and README docs.

---

# Action 5 — Prompt Prefix Cache Stability Tests

## Summary

Add tests and documentation to ensure stable provider-facing prompt prefixes across repeated invocations of the same skill.

## Problem

Provider prompt caching depends on byte-stable prefixes. `executeSkill(...)` currently constructs the system prompt from skill instructions, `AUGGIE_DIRECTIVE`, and optional appendix. This is likely cache-friendly, but there is no explicit invariant test.

## Goal

Protect cache efficiency from future regressions.

## Non-goals

- Do not implement provider-specific prompt caching APIs.
- Do not change model selection behavior.
- Do not log or expose full prompts.

## Proposed Design

### 1. Extract prompt construction

If not already easily testable, extract system prompt construction from `executeSkill(...)`:

```ts
export function buildSubAgentSystemPrompt(input: {
  skillInstructions: string;
  appendix?: string;
}): string
```

Current order should remain:

1. `skill.instructions`
2. `AUGGIE_DIRECTIVE`
3. optional appendix

The dynamic brief should remain in `userPrompt`, not system prompt.

### 2. Add invariant tests

Test that for the same skill and same appendix:

- repeated invocations produce identical system prompt bytes,
- different user goals do not change the system prompt,
- route metadata does not enter the system prompt,
- model selection does not enter the system prompt.

### 3. Add optional hash logging

For debugging only, log a hash of the prompt prefix, not the prompt text:

```json
{
  "event": "auggie-router.prompt-prefix",
  "skill": "docs",
  "sha256": "...",
  "bytes": 12345
}
```

This should be opt-in or debug-level only.

## Files Likely Touched

- `src/subAgent.ts`
- Tests under `tests/`.
- Possibly README or docs.

## Configuration

Optional:

```json
{
  "debugPromptPrefixHash": false
}
```

Default: `false`.

## Acceptance Criteria

- System prompt construction is unit-tested.
- Brief/user goal changes do not alter the system prompt.
- Execution route changes do not alter the system prompt.
- No raw system prompt is logged.
- Documentation mentions the cache-stability invariant.

## Tests

- Same skill + same appendix -> same SHA-256 hash.
- Same skill + different brief -> same SHA-256 hash.
- Same skill + different selected model -> same SHA-256 hash.
- Different appendix -> different hash.
- Different skill instructions -> different hash.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Over-optimizing for caching constrains useful prompt changes | Tests should protect only accidental dynamic data injection, not prevent intentional skill edits. |
| Hash logs become a side channel | Hash only at debug level; no prompt text. |

## Suggested Milestones

1. Extract `buildSubAgentSystemPrompt(...)`.
2. Add cache-stability unit tests.
3. Optionally add debug hash logging.
4. Document invariant near adaptive routing/cache notes.

---

# Action 6 — Parallel Independent Sub-Agents

## Summary

Allow a skill execution to delegate independent heavy retrieval/analysis tasks to multiple sub-agents, then synthesize their compact outputs.

## Problem

A single sub-agent can accumulate too much context when a skill requires several independent investigations, such as comparing two modules, analyzing multiple packages, or searching unrelated subsystems.

## Goal

Keep each heavy task's context isolated and small, then combine only final findings.

## Non-goals

- Do not make every skill use multiple sub-agents.
- Do not recursively spawn unbounded agents.
- Do not share raw retrieval payloads between sub-agents.

## Proposed Design

### 1. Add an optional decomposition phase

After Actor/Judge passes, a planner may decide whether the task can be split.

MVP should avoid another LLM call. Instead, support explicit skill opt-in via frontmatter or settings later, for example:

```yaml
parallelSubagents: true
maxSubagents: 3
```

Or a router setting:

```json
{
  "parallelSubagents": {
    "enabled": false,
    "maxSubagents": 3
  }
}
```

### 2. Define subtask briefs

A subtask brief should include:

- subtask goal,
- scope boundary,
- retrieval instructions,
- output schema,
- maximum final answer size.

### 3. Run sub-agents with isolated context

Each sub-agent gets:

- same skill instructions or a narrowed worker prompt,
- Auggie directive,
- one subtask brief,
- same timeout/inactivity constraints or stricter per-worker limits.

### 4. Synthesize results

A final synthesis step combines worker outputs. Options:

1. Use the main selected execution model in a short LLM call.
2. Use another sub-agent with no Auggie tools and only compact worker outputs.
3. Do deterministic concatenation for structured outputs.

### 5. Concurrency and cancellation

- Enforce `maxSubagents`.
- Apply total timeout across the whole skill execution.
- Cancel remaining workers if one fails only when failure is fatal.
- Surface partial results only if the skill allows it.

## Files Likely Touched

- `src/index.ts`
- `src/subAgent.ts`
- `src/types.ts`
- `src/config.ts`
- New: `src/parallelSubagents.ts`
- Tests under `tests/`.
- Docs for skill authors.

## Acceptance Criteria

- Feature is disabled by default.
- Router can run 2+ independent worker sub-agents for an opted-in skill.
- Each worker has isolated prompt/context.
- Worker outputs are capped before synthesis.
- Total timeout and max concurrency are enforced.
- Failures are reported clearly.

## Tests

- Disabled setting preserves current single-sub-agent behavior.
- Opted-in task creates expected worker briefs.
- Runs workers concurrently with max concurrency.
- Caps worker output size.
- Handles one worker failure according to policy.
- Synthesizes compact final answer.
- Does not leak worker tool traces to main thread.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Cost multiplies quickly | Disabled by default; maxSubagents; per-worker timeouts. |
| Planner decomposition is unreliable | Start with explicit skill opt-in and deterministic subtask definitions. |
| Main thread receives too much output | Cap worker outputs and synthesize only compact findings. |
| Debugging becomes harder | Structured logs with worker IDs, durations, stopped reasons. |

## Suggested Milestones

1. Add config and type definitions, disabled by default.
2. Implement deterministic worker runner utility.
3. Add explicit internal API for skills/hosts to provide subtasks.
4. Add synthesis step.
5. Add tests and docs.

---

# Action 7 — Final Output Trace Stripping

## Summary

Sanitize sub-agent final output before posting it to the main Pi thread, removing accidental MCP/tool traces, raw retrieval blobs, and internal scratchpad-like sections.

## Problem

The router posts `result.finalText` directly to the main thread. If a sub-agent includes tool output or internal traces in its final answer, that noise pollutes the user's conversation and future `historyWindow` context.

## Goal

Keep the main thread clean: user command in, synthesized result out.

## Non-goals

- Do not hide legitimate code snippets or file paths from useful answers.
- Do not mutate files or tool results.
- Do not rely on perfect detection of every possible trace format.

## Proposed Design

### 1. Add an output sanitizer

Create:

```text
src/outputSanitizer.ts
```

Function:

```ts
sanitizeFinalText(text: string, options: OutputSanitizerOptions): {
  text: string;
  removedSections: number;
  warnings: string[];
}
```

### 2. Detect high-confidence trace patterns

Examples:

- MCP JSON envelopes,
- repeated `tool_use` / `tool_result` markers,
- raw `codebase-retrieval` result headers if present,
- extremely large pasted retrieval sections,
- assistant self-labels such as `Analysis:` when clearly scratchpad-like.

Use conservative rules. Prefer removing only fenced or clearly marked internal sections.

### 3. Cap final answer length optionally

Add a high but finite final answer cap, for example:

```json
{
  "finalOutputMaxChars": 120000
}
```

If exceeded, truncate with a clear marker.

### 4. Log sanitization metadata

Do not log removed content. Log only counts:

```json
{
  "event": "auggie-router.output-sanitized",
  "removedSections": 2,
  "originalChars": 180000,
  "finalChars": 60000
}
```

## Files Likely Touched

- `src/index.ts`
- `src/config.ts`
- `src/types.ts`
- New: `src/outputSanitizer.ts`
- Tests under `tests/`.
- README docs.

## Configuration

Example:

```json
{
  "outputSanitizer": {
    "enabled": true,
    "finalOutputMaxChars": 120000,
    "stripToolTraces": true
  }
}
```

Default recommendation:

- `enabled: true` if rules are conservative.
- `stripToolTraces: true`.

## Acceptance Criteria

- Clean final answers are unchanged.
- Clearly marked tool traces are removed.
- Raw retrieval blobs above threshold are removed or replaced with a marker.
- Sanitization metadata is logged without content.
- Main thread receives sanitized text.

## Tests

- Leaves normal markdown answer unchanged.
- Removes fenced block labeled `tool_result`.
- Removes repeated MCP envelope JSON.
- Truncates final output above max chars with marker.
- Does not remove legitimate code fences labeled `ts`, `js`, `json`, etc.
- Logs counts only.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Sanitizer removes useful content | Conservative pattern matching; tests for legitimate code blocks. |
| Sanitizer misses some traces | Best-effort is acceptable; prompt sub-agent to avoid traces too. |
| Truncation hides important final details | High default cap; explicit truncation marker. |

## Suggested Milestones

1. Implement conservative sanitizer with tests.
2. Wire into `host.postAssistantMessage(...)` path.
3. Add config validation.
4. Add logs and docs.

---

# 3. Suggested Implementation Order

Although each action is independent, the recommended order is:

1. **Action 2 — Long-Session Evaluation Fixtures**  
   Establishes a safety net before changing context behavior.

2. **Action 5 — Prompt Prefix Cache Stability Tests**  
   Low-risk invariant protection.

3. **Action 7 — Final Output Trace Stripping**  
   Keeps future chat history cleaner.

4. **Action 4 — Context Budget by Execution Tier**  
   Small change that uses existing Judge metadata.

5. **Action 3 — Head/Tail Chat History Assembly**  
   More invasive Actor/Judge prompt change; should use long-session fixtures.

6. **Action 1 — Overflow Context Memory**  
   High impact, but requires careful tool/memory lifecycle design.

7. **Action 6 — Parallel Independent Sub-Agents**  
   Most complex; best treated as a later feature once memory/eval foundations exist.

## 4. Cross-Cutting Requirements

For all actions:

- Preserve backwards compatibility by default where possible.
- Do not log raw user content, raw chat history, or raw retrieval payloads.
- Keep dynamic route/context metadata out of the sub-agent system prompt unless intentionally changing cache behavior.
- Keep the main thread clean: synthesized final result only.
- Add deterministic tests before optional live/provider tests.
- Ensure all new settings are validated in `src/config.ts`.
