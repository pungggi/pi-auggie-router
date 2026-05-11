# PRD: Harness Self-Evolution via Execution Traces

**Package:** `pi-auggie-router`
**Status:** Draft — no implementation yet
**Author:** pi-auggie-router contributors
**Date:** 2026-05-11
**Source insight:** "Rethinking Agents — Harness Is All You Need" (Stanford + Tsinghua research)

---

## 1. Problem Statement

The Tsinghua and DSPy research demonstrated that:

1. **The same model produces 6× performance variation** depending on the harness.
2. **Raw execution traces are irreplaceable** for improving harnesses. Summarizing traces drops accuracy from 50% → 34%.
3. **Self-evolution is the only consistently helpful module** in ablation studies.
4. **A harness optimized on one model transfers to 5 others** — the reusable asset is the harness, not the model.

Today `pi-auggie-router` has no mechanism to learn from past executions. Every `/skill` invocation starts from scratch. The trace store (added in v1.4.0) captures raw transcripts, but nobody reads them.

**This PRD proposes closing the loop:** use failed execution traces to automatically propose improvements to SKILL.md instructions, and validate those improvements against real task outcomes.

---

## 2. Vision

A self-improving harness that:

1. **Collects** raw execution traces (already done via `ExecutionTraceStore`).
2. **Detects** failures and performance regressions from trace signals.
3. **Proposes** rewrites to SKILL.md instructions using a proposer model.
4. **Validates** proposals against a benchmark of representative tasks.
5. **Applies** validated improvements automatically or surfaces them for human review.

The loop is **opt-in, conservative, and human-in-the-loop by default**.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Harness Self-Evolution Loop                  │
│                                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────┐     │
│  │ Execute   │───▶│ Trace Store  │───▶│ Failure Detector   │     │
│  │ /skill    │    │ (.pi/traces/)│    │ (classify outcome) │     │
│  └──────────┘    └──────────────┘    └────────┬───────────┘     │
│                                               │                  │
│                                    failed / regressed?           │
│                                               │                  │
│                  ┌────────────────────────────▼───────────┐     │
│                  │ Proposer (LLM)                         │     │
│                  │ Input: raw trace + current SKILL.md     │     │
│                  │ Output: proposed SKILL.md rewrite       │     │
│                  └────────────────────────────┬───────────┘     │
│                                               │                  │
│                  ┌────────────────────────────▼───────────┐     │
│                  │ Validator                               │     │
│                  │ Re-run benchmark tasks with proposed    │     │
│                  │ SKILL.md; compare vs. baseline          │     │
│                  └────────────────────────────┬───────────┘     │
│                                               │                  │
│                           improvement confirmed?                │
│                          ╱                      ╲               │
│                        yes                       no              │
│                        ╱                          ╲              │
│  ┌──────────────────────▼──┐    ┌──────────────────▼──┐        │
│  │ Apply / Surface Diff    │    │ Discard Proposal    │        │
│  │ (update SKILL.md)       │    │ (log reason)        │        │
│  └─────────────────────────┘    └─────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Design

### 4.1 Trace Store (✅ Already shipped — v1.4.0)

**Status:** Complete.

The `ExecutionTraceStore` persists full sub-agent transcripts to `.pi/traces/<skillName>_<timestamp>.json`. Each trace contains:

- Skill name, model, brief, route
- Tool calls (server, tool, args, result preview, blocked flag, timestamp)
- Final text and stopped reason

### 4.2 Failure Detector

**Status:** Not started.

**Purpose:** Classify a completed trace as success, failure, or regression.

**Classification signals:**

| Signal | Interpretation |
|---|---|
| `stoppedReason === "timeout"` | Sub-agent hit wall clock limit |
| `stoppedReason === "inactivity"` | Model stopped making tool calls |
| `stoppedReason === "aborted"` | External cancellation |
| Empty `finalText` | No output produced |
| `finalText` contains error markers | Model reported failure |
| High `toolCalls` count with no convergence | Model spinning |
| `route.confidence < 0.5` | Judge was uncertain |

**Interface:**

```ts
interface TraceVerdict {
  outcome: "success" | "failure" | "regression" | "unknown";
  signals: string[];           // Human-readable reasons
  confidence: number;          // 0..1
  previousTraceId?: string;    // Link to prior trace for regression detection
}

function classifyTrace(
  trace: ExecutionTrace,
  previousTraces: ExecutionTrace[]
): TraceVerdict;
```

**Key design decisions:**

- **Deterministic first.** The initial classifier uses heuristics (no LLM). Fast, free, repeatable.
- **LLM-enhanced later.** An optional second pass can ask a model to classify ambiguous traces. Opt-in only.
- **Regression detection:** Compare current trace signals against the last N traces for the same skill. If a previously-successful signal now fails, flag as regression.

### 4.3 Proposer

**Status:** Not started.

**Purpose:** Read a failed trace + current SKILL.md → propose an improved SKILL.md.

**Interface:**

```ts
interface Proposal {
  /** The proposed new instructions (replaces SKILL.md body). */
  proposedInstructions: string;
  /** Human-readable explanation of what changed and why. */
  rationale: string;
  /** Which signals from the trace motivated the change. */
  addressedSignals: string[];
  /** The trace that triggered this proposal. */
  sourceTraceId: string;
}

async function proposeRewrite(input: {
  currentInstructions: string;
  failedTrace: ExecutionTrace;
  verdict: TraceVerdict;
  proposerModel: string;
  host: PiHost;
}): Promise<Proposal>;
```

**Proposer prompt design:**

The proposer receives:
1. The **full raw trace** — not a summary (the research shows summaries hurt).
2. The **current SKILL.md instructions**.
3. The **verdict** (which signals triggered this).
4. **Explicit constraints**: "Only modify the instructions, not the YAML frontmatter. Preserve the skill's intent. Do not add verification loops (they hurt performance per Tsinghua research)."

The proposer should be a **strong model** (frontier tier). The DSPy paper used Claude Opus 4.6 for proposing and achieved Rank 1 with Haiku for execution — the asymmetry is deliberate.

**Safety constraints:**

- The proposer MUST NOT modify YAML frontmatter (model, etc.).
- The proposer MUST NOT inject tool definitions or MCP server instructions.
- The proposer MUST NOT add verification/search loops unless the user explicitly opted in.
- The proposer's output is a **proposal**, not a live edit.

### 4.4 Validator

**Status:** Not started.

**Purpose:** Re-run a benchmark of tasks with the proposed SKILL.md and compare outcomes.

**Interface:**

```ts
interface ValidationReport {
  proposalId: string;
  baselineResults: BenchmarkResult[];
  proposedResults: BenchmarkResult[];
  /** Did the proposal improve on the baseline? */
  improved: boolean;
  /** Statistical confidence (0..1). */
  confidence: number;
  summary: string;
}

interface BenchmarkResult {
  taskName: string;
  success: boolean;
  stoppedReason: string;
  toolCallCount: number;
  durationMs: number;
}

async function validateProposal(input: {
  proposal: Proposal;
  benchmarkTasks: BenchmarkTask[];
  skill: ParsedSkill;
  settings: RouterSettings;
  host: PiHost;
}): Promise<ValidationReport>;
```

**Benchmark tasks:**

Each skill can define a benchmark in `.pi/benchmarks/<skillName>.json`:

```json
[
  {
    "name": "basic-rename",
    "userInput": "/skill:rename rename getCwd to getCurrentWorkingDirectory in src/utils.ts",
    "expectedOutcome": "success"
  }
]
```

The user creates these manually (or they're auto-generated from past successful traces).

**Validation flow:**

1. Run each benchmark task with the **current** SKILL.md → baseline results.
2. Run each benchmark task with the **proposed** SKILL.md → proposed results.
3. Compare: success rate, tool call efficiency, duration.
4. A proposal is "improved" if success rate is ≥ baseline AND no individual task regresses.

### 4.5 Applier

**Status:** Not started.

**Purpose:** Apply validated proposals to SKILL.md files.

**Modes:**

| Mode | Behavior |
|---|---|
| `suggest` (default) | Surface the diff in the Pi chat for human review. User confirms or rejects. |
| `auto-apply` | Automatically update the SKILL.md file. Requires explicit opt-in. |

**Safety:**

- Always creates a backup of the original SKILL.md at `.pi/skill-backups/<name>_<timestamp>.md`.
- Logs every application with before/after hashes.
- Never auto-applies if the benchmark didn't show clear improvement.

---

## 5. Configuration

```json
{
  "auggieRouter": {
    "executionTrace": {
      "enabled": true,
      "maxResultPreviewChars": 2000,
      "traceDirectory": ".pi/traces"
    },
    "harnessEvolution": {
      "enabled": false,
      "mode": "suggest",
      "proposerModel": "anthropic/claude-opus-4-6",
      "maxTracesPerProposal": 5,
      "minTracesBeforeProposal": 3,
      "benchmarkPath": ".pi/benchmarks",
      "applyMode": "suggest",
      "autoApplyMinConfidence": 0.9
    }
  }
}
```

---

## 6. Phased Rollout Plan

### Phase 1 — Trace Collection (✅ Done)

Already shipped in v1.4.0. The `ExecutionTraceStore` captures raw transcripts.

### Phase 2 — Failure Detection + CLI Reporting

**Goal:** Make trace data visible and actionable without any LLM involvement.

- Implement `classifyTrace()` with deterministic heuristics.
- Add a CLI or Pi command: `/skill:trace-report <name>` → show last N traces with verdicts.
- Add a system message after failed executions: "Trace saved. 3 consecutive failures detected for skill 'refactor'."

### Phase 3 — Proposer (Human-in-the-Loop)

**Goal:** Use an LLM to propose SKILL.md rewrites from failed traces.

- Implement `proposeRewrite()`.
- Surface proposals as diffs in the Pi chat.
- User can accept/reject each proposal.
- No automatic application.

### Phase 4 — Validation

**Goal:** A/B test proposals against benchmark tasks before surfacing them.

- Implement `validateProposal()`.
- Define benchmark format (`.pi/benchmarks/<skillName>.json`).
- Only surface proposals that pass validation.

### Phase 5 — Auto-Evolution (Optional)

**Goal:** Run the full loop automatically on a schedule.

- Trigger proposals after N consecutive failures.
- Auto-apply validated proposals when `applyMode: "auto-apply"`.
- Rate limit: max 1 proposal per skill per day.
- Always create backups.

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Proposer degrades SKILL.md quality | Validation gate + human review + backups |
| Benchmark tasks don't represent real usage | Start with `suggest` mode; user curates benchmarks |
| Proposer model cost | Rate limiting; strong model only for proposing, cheap model for execution |
| Trace data grows unbounded | Add TTL / max-trace-count cleanup; configurable retention |
| Prompt injection in traces influences proposer | Sanitize tool call results before feeding to proposer; treat trace data as untrusted |
| False regression detection | Require multiple consecutive failures before proposing; use statistical confidence |
| Self-referential loop (proposer improves itself) | The proposer only reads traces and proposes SKILL.md changes — it never modifies its own prompt or the evolution loop config |

---

## 8. Success Metrics

| Metric | Target |
|---|---|
| Failure rate decrease after applying proposals | ≥ 20% relative improvement |
| False positive proposal rate (rejected by human) | ≤ 30% |
| False negative rate (missed improvement opportunity) | Measured but not gated |
| Proposer cost per proposal | ≤ $0.10 USD equivalent |
| Time from failure to proposal | ≤ 5 minutes |

---

## 9. Dependencies on Current Codebase

| Component | Status | Notes |
|---|---|---|
| `ExecutionTraceStore` | ✅ Shipped | Persists raw traces to `.pi/traces/` |
| `makeTraceMiddleware` | ✅ Shipped | Records tool calls non-blockingly |
| `ExecutionTraceSettings` in types | ✅ Shipped | Config surface in `RouterSettings` |
| `runActorJudgeLoop` | ✅ Shipped | Can be extended to feed trace context |
| `executeSkill` in subAgent.ts | ✅ Shipped | Can be wired to create trace stores |
| Trace middleware wiring in index.ts | 🔲 Needed | Must compose trace middleware into sub-agent execution |
| Failure classifier | 🔲 New | Phase 2 |
| Proposer prompt + API | 🔲 New | Phase 3 |
| Validator + benchmark runner | 🔲 New | Phase 4 |

---

## 10. What We Can Do Today to Prepare

1. **Wire the trace middleware into `executeSkill`** — Compose `makeTraceMiddleware(store)` into the middleware chain so traces are captured by default when `executionTrace.enabled` is true.
2. **Persist traces after sub-agent completion** — In `index.ts`, after `executeSkill()` resolves, call `store.finalize()` and `store.persist()`.
3. **Add a trace summary to structured logs** — Emit tool-call count, duration, and outcome alongside existing route logs.
4. **Document the `.pi/traces/` format** — So future tools can read it.
5. **Add a trace cleanup helper** — TTL-based cleanup to prevent unbounded growth.

These are **zero-risk preparation steps** that don't change any user-visible behavior but make Phase 2+ trivial to implement.

---

## 11. Open Decisions

| Decision | Status | Options | Current recommendation |
|---|---|---|---|
| Should the proposer run inline (blocking) or async? | `[!]` | inline / async / scheduled | Async — don't block the user's workflow |
| Should benchmarks be auto-generated from successful traces? | `[!]` | yes / no / hybrid | Hybrid — suggest from traces, user confirms |
| What's the minimum trace history before proposing? | `[!]` | 1 / 3 / 5 | 3 — avoids single-trace overfitting |
| Should the proposer have access to all traces or just failures? | `[!]` | all / failures only | All — the DSPy paper reads both successful and failed traces |
| How to handle skills with no benchmarks defined? | `[!]` | skip / suggest-only / use-traces-as-benchmark | suggest-only — can't validate without benchmarks |
