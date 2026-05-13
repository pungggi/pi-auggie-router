# Grill Session: Self-Evolution PRD

Started: 2026-05-11
Last updated: 2026-05-11
Status: complete
Domain: Software architecture / product design — interrogating the plan for harness self-evolution in pi-auggie-router

## Summary

The self-evolution PRD (since rewritten and renamed to `docs/PRD-trace-observability.md`) proposed a 5-phase loop (trace collection → failure detection → LLM proposer → benchmark validation → auto-apply) inspired by the Tsinghua/DSPy "Harness Is All You Need" research. Through interrogation, we determined that the core mechanism (measure → propose → validate → apply) depends on objective ground-truth scoring that does not exist in auggie-router's open-ended, one-shot execution environment. The PRD was excitement-driven, not pain-driven. The decision is to kill phases 3-5 and reframe the PRD around lightweight trace observability.

## Decision Log

### DECIDED: The self-evolution loop (phases 3-5) should not be built
- **Decision**: Kill the LLM proposer, validator, and auto-apply phases. The Tsinghua technique requires objective ground truth (MATH-500, HumanEval test suites) which does not exist in auggie-router's domain of open-ended skill execution.
- **Rationale**: 
  - "Failure" cannot be objectively determined for open-ended tasks (refactoring, document generation, code exploration)
  - Without objective failure detection, the proposer would rewrite instructions based on false signals
  - Without objective validation, there's no reliable signal that a rewrite improved anything
  - The PRD was excitement-driven, not pain-driven — no specific user pain point motivated it
- **Date**: 2026-05-11

### DECIDED: Reframe the PRD as trace observability
- **Decision**: Keep Phase 1 (trace store, already shipped) and Phase 2 (failure detection + reporting). Reframe the PRD around making traces legible to humans, not automating instruction rewriting.
- **Rationale**:
  - Traces are already being collected but rotting unread — that's a real waste problem
  - `/skill:trace-report` and structured logging give humans actionable insight without needing ground truth
  - This is 80% of the value at 5% of the cost
  - Future self-evolution work should target a benchmark environment with objective scoring, not the live router
- **Concrete deliverables**:
  1. `/skill:trace-report <name>` — show last N traces with heuristic verdicts
  2. Structured failure alerts — "3 consecutive timeouts detected for skill 'refactor'"
  3. Optional trace viewer for debugging individual failed executions
- **Date**: 2026-05-11

## Open Threads

_None — the primary decision cascades through all branches._

## Parking Lot

The following were identified as grill branches but became moot after the main decision:

1. **The "full raw trace" assumption** — Truncation to 2000 chars already contradicts "no summaries." Moot: no proposer to feed traces to.
2. **The failure classification problem** — Heuristic signals are fragile. Partially relevant: even for observability, heuristic verdicts will have false positives. But the stakes are lower (human reviews, no auto-rewrite).
3. **The proposer's attack surface** — Moot: no proposer.
4. **The validation cold-start problem** — Moot: no validator.
5. **Feedback loop dynamics** — Moot: no closed loop.
6. **Cost and latency reality check** — Moot: no LLM in the loop.
