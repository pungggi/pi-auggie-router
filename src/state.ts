import type { JudgeRubric, ParsedSkill, SkillBrief } from "./types.js";

/**
 * Per PRD §2.4 + §3 (Concurrency Lock): a single in-memory state machine
 * gates the router. There is at most one in-flight skill execution; while
 * running the user's main editor input is locked.
 */

export type RouterPhase = "idle" | "evaluating" | "waitingForUser" | "executing";

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
    if (this._phase !== "evaluating" && this._phase !== "waitingForUser") {
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
   * Consume the user's clarification input. Returns the captured pending
   * context so the caller can splice the answer into the brief.
   */
  consumeUserAnswer(answer: string): PendingSkillContext {
    if (this._phase !== "waitingForUser" || !this._pending) {
      throw new Error("No pending Q&A to consume");
    }
    const pending = this._pending;
    pending.resolve(answer);
    return pending;
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
