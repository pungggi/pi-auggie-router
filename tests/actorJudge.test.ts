import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runActorJudgeLoop } from "../src/actorJudge.ts";
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
