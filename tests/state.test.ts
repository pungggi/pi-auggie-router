import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouterState } from "../src/state.ts";

function makePending() {
  let resolved: string | null = null;
  let rejected: Error | null = null;
  return {
    skill: { name: "x", filePath: "x", rawModel: undefined, instructions: "" },
    brief: { userGoal: "", constraints: [], knownContext: "", userClarifications: [] },
    rubric: {
      hasUserGoal: false,
      hasRequiredInputs: false,
      hasScopeBoundary: false,
      isUnambiguous: false,
    },
    resolve: (a: string) => {
      resolved = a;
    },
    reject: (e: Error) => {
      rejected = e;
    },
    get resolved() {
      return resolved;
    },
    get rejected() {
      return rejected;
    },
  };
}

describe("RouterState", () => {
  it("starts idle and tracks busy state", () => {
    const s = new RouterState();
    assert.equal(s.phase, "idle");
    assert.equal(s.isBusy(), false);
  });

  it("rejects double evaluation", () => {
    const s = new RouterState();
    s.beginEvaluation();
    assert.throws(() => s.beginEvaluation());
  });

  it("transitions evaluating -> waitingForUser -> resuming -> executing", () => {
    const s = new RouterState();
    s.beginEvaluation();
    const p = makePending();
    s.beginWaitForUser(p as any);
    assert.equal(s.phase, "waitingForUser");
    s.consumeUserAnswer("the answer");
    assert.equal(p.resolved, "the answer");
    assert.equal(s.phase, "resuming");
    s.beginExecution();
    assert.equal(s.phase, "executing");
  });

  it("consumeUserAnswer is single-shot — second call throws", () => {
    const s = new RouterState();
    s.beginEvaluation();
    const p = makePending();
    s.beginWaitForUser(p as any);
    s.consumeUserAnswer("first");
    assert.throws(() => s.consumeUserAnswer("second"));
  });

  it("rejectPending(reason) resolves the pending Q&A as rejected and returns to idle", () => {
    const s = new RouterState();
    s.beginEvaluation();
    const p = makePending();
    s.beginWaitForUser(p as any);
    s.rejectPending(new Error("timed out"));
    assert.equal(s.phase, "idle");
    assert.ok(p.rejected instanceof Error);
    assert.equal(p.rejected!.message, "timed out");
  });

  it("rejectPending is a no-op when nothing is pending", () => {
    const s = new RouterState();
    s.rejectPending(new Error("no-op"));
    assert.equal(s.phase, "idle");
  });

  it("forbids beginExecution from idle", () => {
    const s = new RouterState();
    assert.throws(() => s.beginExecution());
  });

  it("reset() rejects any in-flight Q&A and returns to idle", () => {
    const s = new RouterState();
    s.beginEvaluation();
    const p = makePending();
    s.beginWaitForUser(p as any);
    s.reset();
    assert.equal(s.phase, "idle");
    assert.ok(p.rejected instanceof Error);
  });

  it("consumeUserAnswer throws when not waiting", () => {
    const s = new RouterState();
    assert.throws(() => s.consumeUserAnswer("nope"));
  });
});
