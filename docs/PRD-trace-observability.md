# PRD: Trace Observability for Skill Debugging

**Package:** `pi-auggie-router`
**Status:** Draft — replaces former "Harness Self-Evolution" PRD
**Author:** pi-auggie-router contributors
**Date:** 2026-05-11

---

## 1. Problem Statement

The `ExecutionTraceStore` (shipped in v1.4.0) captures full sub-agent transcripts to `.pi/traces/` — tool calls, results, final output, stop reasons. But nobody reads them. Traces pile up, rot, and provide zero value to users.

When a skill fails or produces poor results, users have no way to understand *why*:
- Did the sub-agent time out?
- Did it loop on the same tool call?
- Did the judge route it to a weak model?
- Has this skill been failing consistently, or was this a one-off?

Today the user sees a final text output (or an error) and has nothing else to go on. That's the real problem: **traces exist but are invisible**.

### Why not self-evolution?

The original version of this PRD proposed a self-evolution loop (LLM proposer → benchmark validator → auto-apply) inspired by the Tsinghua/DSPy "Harness Is All You Need" research. That research demonstrated powerful results — but in a **repeated-task, objective-scoring** environment (MATH-500, HumanEval). Auggie-router skills are open-ended, one-shot, and have no ground truth. You cannot objectively determine whether a refactoring task "succeeded," which means the propose → validate → apply loop has no reliable signal to close on.

The right move is **observability first**: make traces legible to humans so they can debug, learn, and improve their skills themselves. If a self-evolution mechanism ever makes sense, it would need a benchmark environment with objective scoring — a separate project.

---

## 2. Vision

A lightweight observability layer that:

1. **Collects** raw execution traces (already done via `ExecutionTraceStore`).
2. **Classifies** trace outcomes using deterministic heuristics — no LLM required.
3. **Reports** skill health over time: success rates, failure patterns, performance trends.
4. **Alerts** users to degraded skills in real time ("3 consecutive timeouts on skill 'refactor'").
5. **Enables** single-trace debugging — view the full tool call timeline of any past execution.

The loop is **human-driven**: the system surfaces insights, the human decides what to do.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Trace Observability Pipeline                 │
│                                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────┐     │
│  │ Execute   │───▶│ Trace Store  │───▶│ Trace Classifier   │     │
│  │ /skill    │    │ (.pi/traces/)│    │ (heuristic only)   │     │
│  └──────────┘    └──────────────┘    └────────┬───────────┘     │
│                                               │                  │
│                                    verdict + history             │
│                                               │                  │
│               ┌───────────────────────────────▼────────────┐    │
│               │ Observability Layer                         │    │
│               │                                              │    │
│               │  ┌─────────────────┐  ┌──────────────────┐  │    │
│               │  │ Trace Report    │  │ Degradation      │  │    │
│               │  │ (/skill cmd)    │  │ Alert            │  │    │
│               │  └─────────────────┘  └──────────────────┘  │    │
│               │                                              │    │
│               │  ┌─────────────────┐  ┌──────────────────┐  │    │
│               │  │ Single-Trace    │  │ Trend Detection  │  │    │
│               │  │ Viewer          │  │ (success rate)   │  │    │
│               │  └─────────────────┘  └──────────────────┘  │    │
│               └──────────────────────────────────────────────┘    │
│                                                                  │
│               ┌──────────────────────────────────────────────┐    │
│               │ Human                                         │    │
│               │ Reads reports → diagnoses problems →         │    │
│               │ updates SKILL.md manually                    │    │
│               └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Design

### 4.1 Trace Store (✅ Already shipped — v1.4.0)

**Status:** Complete. No changes needed.

The `ExecutionTraceStore` persists full sub-agent transcripts to `.pi/traces/<skillName>_<timestamp>.json`. Each trace contains:

- Skill name, model, brief, route
- Tool calls (server, tool, args, result preview up to `maxResultPreviewChars`, blocked flag, timestamp)
- Final text and stopped reason

### 4.2 Trace Classifier

**Status:** Not started.

**Purpose:** Classify a completed trace's outcome using deterministic heuristics. No LLM involved — fast, free, repeatable.

**Classification signals:**

| Signal | Interpretation |
|---|---|
| `stoppedReason === "timeout"` | Sub-agent hit wall clock limit |
| `stoppedReason === "inactivity"` | Model stopped making tool calls |
| `stoppedReason === "aborted"` | External cancellation |
| Empty `finalText` | No output produced |
| `finalText` contains error markers (`"error"`, `"failed"`, `"exception"` — case-insensitive, in first 200 chars) | Model reported failure |
| Tool call count > 20 | Possible spinning / excessive iteration |
| Route confidence < 0.5 | Judge was uncertain about routing |

**Important caveat:** These heuristics produce **approximate** verdicts, not ground truth. A complex refactoring task might legitimately take 20+ tool calls. The classifier's job is to **flag patterns for human review**, not to make autonomous decisions. The stakes are low — a false positive just means a human reviews a trace that was actually fine.

**Interface:**

```ts
interface TraceVerdict {
  outcome: "success" | "likely-failure" | "likely-regression" | "unknown";
  signals: string[];
  confidence: number; // 0..1 — how confident the heuristic is
}

function classifyTrace(trace: ExecutionTrace): TraceVerdict;
```

**Regression detection:** Compare against the last N traces for the same skill. If the same signal appears in ≥ 3 consecutive traces and the skill previously had successful traces without that signal, flag as `likely-regression`. Requires loading historical traces — keep N small (default: 10) to bound I/O.

### 4.3 Trace Report

**Status:** Not started.

**Purpose:** Summarize recent trace history for a skill — the primary user-facing surface.

**Surface:** A structured system message emitted after skill execution when the user invokes a reporting command (or optionally after every execution).

**Report format:**

```
📊 Trace Report: skill "refactor" (last 10 runs)

  ✅ Success     ██████████░░  6/10  (60%)
  ⚠️ Likely fail ██████░░░░░░  3/10  (30%)
  ❓ Unknown     ██░░░░░░░░░░  1/10  (10%)

  Common failure signals:
    • timeout (2x) — sub-agent hit wall clock limit
    • high tool-call count (1x) — 28 calls, median is 12

  Trend: success rate dropped from 90% → 60% over last 5 runs.

  Recent traces:
    refactor_20260511_143022.json  ✅  14 calls  45s
    refactor_20260511_141100.json  ⚠️  28 calls  timeout
    refactor_20260511_135800.json  ⚠️  22 calls  timeout
    refactor_20260511_132200.json  ✅  11 calls  38s
    refactor_20260511_124500.json  ✅  13 calls  42s
```

**Trigger options:**

| Trigger | Behavior |
|---|---|
| Manual: `/skill:trace-report <name>` | Always show report for named skill |
| After execution (opt-in) | Show mini-report (last 3 traces) after every skill execution |
| After detected degradation | Show alert when consecutive failures detected |

### 4.4 Degradation Alert

**Status:** Not started.

**Purpose:** Proactively notify the user when a skill's performance degrades — the highest-value feature at the lowest cost.

**Alert conditions (all must be true):**

1. Last N traces (configurable, default 3) all have `outcome !== "success"`.
2. The skill has at least one successful trace in its history (otherwise there's no regression, just a skill that's never worked).
3. The alert hasn't been shown for this skill in the last 24 hours (rate limit to avoid nagging).

**Alert format (system message after execution):**

```
⚠️ Degradation detected: skill "refactor" has failed 3 consecutive times.
   Signals: timeout (3x), high tool-call count (2x).
   Last successful run: 2026-05-11 09:30.
   Use /skill:trace-report refactor for details.
```

### 4.5 Single-Trace Viewer

**Status:** Not started. Lower priority.

**Purpose:** View the full tool-call timeline of a single trace for debugging.

**Surface:** A structured output showing the tool call sequence with timestamps, args summaries, and result previews. This is a **human debugging aid**, not an automated analysis tool.

**Format:**

```
🔍 Trace: refactor_20260511_141100.json
   Model: anthropic/claude-3-5-haiku  |  Route: balanced, medium complexity
   Outcome: ⚠️ likely-failure (timeout)
   Duration: 300s  |  Tool calls: 28

   Timeline:
   [0s]  auggie / codebase-retrieval  → 2,340 chars  ✅
   [3s]  auggie / codebase-retrieval  → 1,890 chars  ✅
   [8s]  auggie / apply-diff          → 420 chars     ✅
   ...
   [290s] auggie / codebase-retrieval  → 3,100 chars  ✅
   [298s] auggie / apply-diff          → 890 chars     ✅
   ⏰ Timeout — sub-agent hit wall clock limit

   Final text: (empty)
```

---

## 5. Configuration

```jsonc
{
  "auggieRouter": {
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
      "regressionWindowSize": 10
    }
  }
}
```

---

## 6. Phased Rollout Plan

### Phase 1 — Trace Collection (✅ Done)

Already shipped in v1.4.0. The `ExecutionTraceStore` captures raw transcripts.

### Phase 2 — Trace Classifier + Structured Logging

**Goal:** Make every execution emit a trace verdict alongside existing route logs.

- Implement `classifyTrace()` with deterministic heuristics.
- Emit structured log with verdict after each execution: `host.log("trace-classified", { skill, verdict, toolCallCount, duration })`.
- Add trace cleanup helper — TTL-based cleanup to prevent unbounded growth.

### Phase 3 — Degradation Alerts

**Goal:** Proactively surface skill degradation to users.

- Track consecutive failure count per skill (from classified traces).
- Emit degradation alert as a system message when conditions are met.
- Rate-limit alerts to avoid nagging.

### Phase 4 — Trace Report Command

**Goal:** On-demand trace history for any skill.

- Implement `/skill:trace-report <name>` command surface.
- Load last N traces, classify them, render summary.
- Include trend line (success rate over time).

### Phase 5 — Single-Trace Viewer (Optional)

**Goal:** Dive into individual traces for deep debugging.

- Implement `/skill:trace-view <filename>` command surface.
- Render tool-call timeline with timestamps and result previews.
- Lower priority — only build if users ask for it.

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Heuristic classifier has high false-positive rate | Stakes are low — false positives just waste a human's time reviewing a fine trace. Tune thresholds based on real data. |
| Traces grow unbounded on disk | TTL-based cleanup helper in Phase 2. Configurable retention. |
| Degradation alerts become noisy | Rate limiting (24h cooldown per skill). Require consecutive failures, not isolated ones. |
| `showReportAfterExecution` clutters output | Off by default. Only shown when explicitly requested or on degradation. |
| "Likely-failure" verdict feels judgmental | Naming is explicit ("likely", not "definitely"). Signals are listed so humans can disagree. |

---

## 8. Success Metrics

| Metric | Target |
|---|---|
| Users can name a failing skill and see why | Qualitative — the report is readable and useful |
| Degradation alert surfaces before user complains | Qualitative — alert fires within 3 consecutive failures |
| False-positive alert rate | ≤ 40% is acceptable (low stakes; humans can dismiss) |
| Trace disk usage | Bounded by TTL (default: 30 days) |
| No LLM cost | Zero — all heuristics are deterministic |

---

## 9. Dependencies on Current Codebase

| Component | Status | Notes |
|---|---|---|
| `ExecutionTraceStore` | ✅ Shipped | Persists raw traces to `.pi/traces/` |
| `makeTraceMiddleware` | ✅ Shipped | Records tool calls non-blockingly |
| `ExecutionTraceSettings` in types | ✅ Shipped | Config surface in `RouterSettings` |
| `executeSkill` in subAgent.ts | ✅ Shipped | Already accepts `traceStore` input |
| Trace middleware wiring in index.ts | 🔲 Needed | Must compose trace middleware into sub-agent execution |
| `classifyTrace()` | 🔲 New | Phase 2 |
| Degradation alert emitter | 🔲 New | Phase 3 |
| Trace report renderer | 🔲 New | Phase 4 |
| Trace cleanup helper | 🔲 New | Phase 2 |
| `TraceObservabilitySettings` in types | 🔲 New | Phase 2 |

---

## 10. What We Can Do Today to Prepare

1. **Wire the trace middleware into `executeSkill`** — Compose `makeTraceMiddleware(store)` into the middleware chain so traces are captured by default when `executionTrace.enabled` is true.
2. **Persist traces after sub-agent completion** — In `index.ts`, after `executeSkill()` resolves, call `store.finalize()` and `store.persist()`.
3. **Add a trace summary to structured logs** — Emit tool-call count, duration, and outcome alongside existing route logs.
4. **Add a trace cleanup helper** — TTL-based cleanup to prevent unbounded growth.
5. **Define `TraceObservabilitySettings`** — Add the config surface to `RouterSettings` and `config.ts`.

These are **zero-risk preparation steps** that don't change any user-visible behavior but make Phase 2 trivial to implement.

---

## 11. Resolved Decisions

All open decisions from the original draft have been resolved through a structured grill session (see `grill-me-sessions/trace-observability-decisions.grill.md`). Summary:

| Decision | Resolution |
|---|---|
| How to surface the trace report? | Auto-threshold: inline system message for ≤5 traces, markdown file for larger |
| Should `classifyTrace` ever use an LLM? | No — deterministic only, `confidence: number` (0..1) |
| Degradation alerts placement | Router (not a separate extension) |
| Default trace retention | Count-based `maxTracesPerSkill` (default 20), no time-based TTL |
| Report inline or to file? | Auto-threshold (merged with report surface decision) |
