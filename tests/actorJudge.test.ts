import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXECUTION_ROUTE,
  coerceExecutionRoute,
  runActorJudgeLoop,
} from "../src/actorJudge.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import type { LLMCallOptions, ParsedSkill, PiHost } from "../src/types.ts";

function makeHost(responses: string[]): { host: PiHost; calls: LLMCallOptions[] } {
  const calls: LLMCallOptions[] = [];
  let i = 0;
  const host: PiHost = {
    postSystemMessage: () => {},
    postAssistantMessage: () => {},
    setInputLocked: () => {},
    getRecentMessages: () => [
      { role: "user", content: "rename getCwd to getCurrentWorkingDirectory in src/utils.ts" },
    ],
    callLLM: async (opts) => {
      calls.push(opts);
      const text = responses[i] ?? "";
      i += 1;
      return { text };
    },
    runSubAgent: async () => ({ finalText: "", stoppedReason: "completed" }),
    onBeforeMessage: () => () => {},
    onUserInput: () => () => {},
    resolveWorkspacePath: (rel) => rel,
    resolveHomePath: (rel) => rel,
  };
  return { host, calls };
}

const SKILL: ParsedSkill = {
  name: "rename",
  filePath: "/tmp/SKILL.md",
  rawModel: undefined,
  instructions: "Rename a symbol across the codebase.",
};

describe("runActorJudgeLoop", () => {
  it("returns passed=true when Judge approves on the first pass", async () => {
    const { host, calls } = makeHost([
      JSON.stringify({
        userGoal: "Rename getCwd to getCurrentWorkingDirectory",
        constraints: ["src/utils.ts only"],
        knownContext: "Symbol referenced from chat",
      }),
      JSON.stringify({
        hasUserGoal: true,
        hasRequiredInputs: true,
        hasScopeBoundary: true,
        isUnambiguous: true,
        missingRequirementQuestion: null,
      }),
    ]);

    const out = await runActorJudgeLoop(host, DEFAULT_SETTINGS, SKILL);
    assert.equal(out.passed, true);
    assert.equal(out.iterations, 1);
    assert.equal(calls.length, 2);
  });

  it("loops once and surfaces the missing-requirement question on second failure", async () => {
    const { host, calls } = makeHost([
      // pass 1: actor + judge (fail)
      JSON.stringify({ userGoal: "", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Which files should be renamed?",
      }),
      // pass 2: actor + judge (still fails)
      JSON.stringify({ userGoal: "Rename", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: true,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Which files should be renamed?",
      }),
    ]);

    const out = await runActorJudgeLoop(host, DEFAULT_SETTINGS, SKILL);
    assert.equal(out.passed, false);
    assert.equal(out.iterations, 2);
    assert.equal(calls.length, 4);
    assert.equal(out.rubric.missingRequirementQuestion, "Which files should be renamed?");
  });

  it("treats malformed Actor JSON as an empty brief without crashing", async () => {
    const { host } = makeHost([
      "this is not JSON",
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Restate the goal please.",
      }),
      "still not JSON",
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Restate the goal please.",
      }),
    ]);

    const out = await runActorJudgeLoop(host, DEFAULT_SETTINGS, SKILL);
    assert.equal(out.passed, false);
    assert.equal(out.brief.userGoal, "");
  });

  it("respects the historyWindow limit for the Actor message", async () => {
    const settings = { ...DEFAULT_SETTINGS, historyWindow: 3 };
    const { host, calls } = makeHost([
      JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: true,
        hasRequiredInputs: true,
        hasScopeBoundary: true,
        isUnambiguous: true,
      }),
    ]);

    let received = 0;
    host.getRecentMessages = (n) => {
      received = n;
      return [];
    };

    await runActorJudgeLoop(host, settings, SKILL);
    assert.equal(received, 3);
    assert.equal(calls[0]!.temperature, 0);
  });

  it("attaches a parsed executionRoute to JudgeOutcome on a passing run", async () => {
    const { host } = makeHost([
      JSON.stringify({
        userGoal: "Rename getCwd to getCurrentWorkingDirectory",
        constraints: ["src/utils.ts only"],
        knownContext: "Symbol referenced from chat",
      }),
      JSON.stringify({
        hasUserGoal: true,
        hasRequiredInputs: true,
        hasScopeBoundary: true,
        isUnambiguous: true,
        missingRequirementQuestion: null,
        executionRoute: {
          tier: "balanced",
          complexity: "medium",
          risk: "small_edit",
          confidence: 0.82,
          reason: "Scoped single-file rename.",
        },
      }),
    ]);
    const out = await runActorJudgeLoop(host, DEFAULT_SETTINGS, SKILL);
    assert.equal(out.passed, true);
    assert.equal(out.route.tier, "balanced");
    assert.equal(out.route.complexity, "medium");
    assert.equal(out.route.risk, "small_edit");
    assert.equal(out.route.confidence, 0.82);
    assert.equal(out.route.reason, "Scoped single-file rename.");
  });

  it("falls back to the default route when Judge omits executionRoute", async () => {
    const { host } = makeHost([
      JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: true,
        hasRequiredInputs: true,
        hasScopeBoundary: true,
        isUnambiguous: true,
      }),
    ]);
    const out = await runActorJudgeLoop(host, DEFAULT_SETTINGS, SKILL);
    assert.equal(out.passed, true);
    assert.deepEqual(out.route, DEFAULT_EXECUTION_ROUTE);
  });

  it("falls back to the default route when Judge JSON is malformed", async () => {
    const { host } = makeHost([
      JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }),
      "this is not JSON",
      JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }),
      "still not JSON",
    ]);
    const out = await runActorJudgeLoop(host, DEFAULT_SETTINGS, SKILL);
    assert.equal(out.passed, false);
    assert.deepEqual(out.route, DEFAULT_EXECUTION_ROUTE);
  });

  it("coerceExecutionRoute returns full default for non-object input", () => {
    assert.deepEqual(coerceExecutionRoute(undefined), DEFAULT_EXECUTION_ROUTE);
    assert.deepEqual(coerceExecutionRoute(null), DEFAULT_EXECUTION_ROUTE);
    assert.deepEqual(coerceExecutionRoute("balanced"), DEFAULT_EXECUTION_ROUTE);
    assert.deepEqual(coerceExecutionRoute([1, 2, 3]), DEFAULT_EXECUTION_ROUTE);
  });

  it("coerceExecutionRoute defaults invalid enum fields", () => {
    const r = coerceExecutionRoute({
      tier: "ultra",
      complexity: "spicy",
      risk: "scary",
      confidence: 0.5,
      reason: "n/a",
    });
    assert.equal(r.tier, "balanced");
    assert.equal(r.complexity, "medium");
    assert.equal(r.risk, "unknown");
    assert.equal(r.confidence, 0.5);
    assert.equal(r.reason, "n/a");
  });

  it("coerceExecutionRoute clamps confidence to [0,1] and rejects non-finite", () => {
    assert.equal(coerceExecutionRoute({ confidence: -2 }).confidence, 0);
    assert.equal(coerceExecutionRoute({ confidence: 5 }).confidence, 1);
    assert.equal(coerceExecutionRoute({ confidence: 0.42 }).confidence, 0.42);
    assert.equal(coerceExecutionRoute({ confidence: Number.NaN }).confidence, 0);
    assert.equal(coerceExecutionRoute({ confidence: "high" }).confidence, 0);
  });

  it("coerceExecutionRoute trims and caps reason length", () => {
    const long = "x".repeat(2000);
    const r = coerceExecutionRoute({ reason: `   ${long}   ` });
    assert.equal(r.reason.length, 500);
    assert.equal(coerceExecutionRoute({ reason: "   " }).reason, DEFAULT_EXECUTION_ROUTE.reason);
    assert.equal(coerceExecutionRoute({ reason: 7 }).reason, DEFAULT_EXECUTION_ROUTE.reason);
  });

  it("strips ```json fences from model output", async () => {
    const { host } = makeHost([
      "```json\n" +
        JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }) +
        "\n```",
      "```\n" +
        JSON.stringify({
          hasUserGoal: true,
          hasRequiredInputs: true,
          hasScopeBoundary: true,
          isUnambiguous: true,
        }) +
        "\n```",
    ]);
    const out = await runActorJudgeLoop(host, DEFAULT_SETTINGS, SKILL);
    assert.equal(out.passed, true);
    assert.equal(out.brief.userGoal, "g");
  });
});
