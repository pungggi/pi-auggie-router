import type { JudgeRubric, ParsedSkill, SkillBrief } from "./types.js";

/**
 * Per PRD §2.4 + §3 (Concurrency Lock): a single in-memory state machine
 * gates the router. There is at most one in-flight skill execution; while
 * running the user's main editor input is locked.
 */

export type RouterPhase =
  | "idle"
  | "evaluating"
  | "waitingForUser"
  | "resuming"
  | "executing";

interface PendingSkillContext {
  skill: ParsedSkill;
  brief: SkillBrief;
  rubric: JudgeRubric;
  /** Resolves when the user supplies the missing context (or rejects). */
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

export class RouterState {
  private _phase: RouterPhase = "idle";
  private _pending: PendingSkillContext | null = null;

  get phase(): RouterPhase {
    return this._phase;
  }

  isBusy(): boolean {
    return this._phase !== "idle";
  }

  beginEvaluation(): void {
    if (this._phase !== "idle") {
      throw new Error(`Router busy (phase=${this._phase})`);
    }
    this._phase = "evaluating";
  }

  beginExecution(): void {
    if (
      this._phase !== "evaluating" &&
      this._phase !== "waitingForUser" &&
      this._phase !== "resuming"
    ) {
      throw new Error(`Cannot execute from phase=${this._phase}`);
    }
    this._phase = "executing";
    this._pending = null;
  }

  beginWaitForUser(ctx: PendingSkillContext): void {
    if (this._phase !== "evaluating") {
      throw new Error(`Cannot wait for user from phase=${this._phase}`);
    }
    this._phase = "waitingForUser";
    this._pending = ctx;
  }

  /**
   * Consume the user's clarification input. Transitions to `resuming` and
   * clears `_pending` synchronously so a fast second `onBeforeMessage` fire
   * — which would otherwise see `phase === "waitingForUser"` and silently
   * swallow the user's next message — falls through as a no-op.
   */
  consumeUserAnswer(answer: string): PendingSkillContext {
    if (this._phase !== "waitingForUser" || !this._pending) {
      throw new Error("No pending Q&A to consume");
    }
    const pending = this._pending;
    this._pending = null;
    this._phase = "resuming";
    pending.resolve(answer);
    return pending;
  }

  /** Reject the pending Q&A (timeout / user cancellation) and reset to idle. */
  rejectPending(reason: Error): void {
    if (!this._pending) return;
    const pending = this._pending;
    this._pending = null;
    this._phase = "idle";
    try {
      pending.reject(reason);
    } catch {
      /* ignore */
    }
  }

  /** Force-reset to idle (used in error paths and on completion). */
  reset(): void {
    if (this._pending) {
      try {
        this._pending.reject(new Error("Router reset before user reply"));
      } catch {
        /* ignore */
      }
    }
    this._pending = null;
    this._phase = "idle";
  }
}
