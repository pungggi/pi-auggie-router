import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeSkill } from "../src/subAgent.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import {
  AUGGIE_MCP_NAME,
  AUGGIE_TOOL_NAME,
} from "../src/auggie.ts";
import type {
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
  SubAgentRunOptions,
  ToolResultMiddleware,
} from "../src/types.ts";

function makeSkill(): ParsedSkill {
  return {
    name: "demo",
    filePath: "/tmp/skill",
    rawModel: undefined,
    instructions: "Do it.",
  };
}

function makeBrief(): SkillBrief {
  return {
    userGoal: "g",
    constraints: [],
    knownContext: "",
    userClarifications: [],
  };
}

function makeHost(): { host: PiHost; calls: SubAgentRunOptions[] } {
  const calls: SubAgentRunOptions[] = [];
  const host: PiHost = {
    postSystemMessage: () => {},
    postAssistantMessage: () => {},
    setInputLocked: () => {},
    getRecentMessages: () => [],
    callLLM: async () => ({ text: "" }),
    runSubAgent: async (opts) => {
      calls.push(opts);
      return { finalText: "ok", stoppedReason: "completed" };
    },
    onBeforeMessage: () => () => {},
    onUserInput: () => () => {},
    resolveWorkspacePath: (rel) => rel,
    resolveHomePath: (rel) => rel,
  };
  return { host, calls };
}

function makeSettings(overflowCeilingBytes: number): RouterSettings {
  return { ...DEFAULT_SETTINGS, overflowCeilingBytes };
}

function callMiddleware(
  mw: ToolResultMiddleware,
  payloadBytes: number
): { block: boolean; replacement?: string } {
  const raw = "x".repeat(payloadBytes);
  return mw(
    { serverName: AUGGIE_MCP_NAME, toolName: AUGGIE_TOOL_NAME, args: {} },
    raw
  );
}

describe("executeSkill — overflow ceiling plumbing", () => {
  it("uses settings.overflowCeilingBytes when input.overflowCeilingBytes omitted", async () => {
    const { host, calls } = makeHost();
    await executeSkill(host, makeSettings(20_000), {
      skill: makeSkill(),
      brief: makeBrief(),
      resolvedModel: "openrouter/x/y",
    });
    const mw = calls[0]!.toolResultMiddleware!;
    assert.equal(callMiddleware(mw, 19_000).block, false, "under ceiling passes");
    const blocked = callMiddleware(mw, 25_000);
    assert.equal(blocked.block, true, "over ceiling is blocked");
    assert.match(blocked.replacement!, /Result too large/);
  });

  it("override via input.overflowCeilingBytes raises the effective ceiling", async () => {
    const { host, calls } = makeHost();
    await executeSkill(host, makeSettings(20_000), {
      skill: makeSkill(),
      brief: makeBrief(),
      resolvedModel: "openrouter/x/y",
      overflowCeilingBytes: 50_000,
    });
    const mw = calls[0]!.toolResultMiddleware!;
    assert.equal(callMiddleware(mw, 25_000).block, false, "25k now under ceiling");
    assert.equal(callMiddleware(mw, 60_000).block, true, "60k over the new ceiling");
  });

  it("override via input.overflowCeilingBytes lowers the effective ceiling", async () => {
    const { host, calls } = makeHost();
    await executeSkill(host, makeSettings(50_000), {
      skill: makeSkill(),
      brief: makeBrief(),
      resolvedModel: "openrouter/x/y",
      overflowCeilingBytes: 10_000,
    });
    const mw = calls[0]!.toolResultMiddleware!;
    assert.equal(callMiddleware(mw, 9_000).block, false);
    assert.equal(callMiddleware(mw, 15_000).block, true, "15k over lowered ceiling");
  });

  it("invalid override (0 or negative) falls back to settings", async () => {
    const { host, calls } = makeHost();
    await executeSkill(host, makeSettings(30_000), {
      skill: makeSkill(),
      brief: makeBrief(),
      resolvedModel: "openrouter/x/y",
      overflowCeilingBytes: 0,
    });
    const mw = calls[0]!.toolResultMiddleware!;
    assert.equal(callMiddleware(mw, 25_000).block, false);
    assert.equal(callMiddleware(mw, 35_000).block, true);
  });
});
