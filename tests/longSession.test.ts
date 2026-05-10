/**
 * Long-session regression suite.
 *
 * Loads every JSON fixture in tests/fixtures/long-session/ and runs the
 * deterministic Actor/Judge loop against a fake `PiHost`. Asserts brief
 * quality, rubric outcome, and execution-route tier — but never makes
 * real LLM calls and never invokes a sub-agent.
 *
 * Add a new fixture by dropping a *.json file in the folder. The schema is
 * documented in the existing fixtures.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runActorJudgeLoop } from "../src/actorJudge.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import type {
  ChatMessage,
  ExecutionRoutingTier,
  ParsedSkill,
  RouterSettings,
} from "../src/types.ts";
import { createFakeHost } from "./helpers/longSessionHost.ts";

interface FixtureSkill {
  name: string;
  instructions: string;
}

interface FixtureExpected {
  rubricPassed: boolean;
  iterations: number;
  routeTier: ExecutionRoutingTier;
  minRouteTier: ExecutionRoutingTier;
  briefGoalKeywords?: string[];
  briefContextKeywords?: string[];
  minJudgeConfidence?: number;
  expectClarificationQuestion?: boolean;
  expandLargeLogPlaceholder?: boolean;
}

interface Fixture {
  name: string;
  description: string;
  skill: FixtureSkill;
  messages: ChatMessage[];
  actorOutputs: unknown[];
  judgeOutputs: unknown[];
  expected: FixtureExpected;
}

const TIER_RANK: Record<ExecutionRoutingTier, number> = {
  cheap: 0,
  balanced: 1,
  frontier: 2,
};

const FIXTURE_DIR = join(__dirname, "fixtures", "long-session");

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture);
}

function expandPlaceholders(messages: ChatMessage[]): ChatMessage[] {
  // Synthetic "big log" — 25k chars of plausibly-noisy content.
  const big = "EVENT row=" + "x".repeat(40) + "\n";
  const bigLog = big.repeat(600); // ~25k chars
  return messages.map((m) =>
    m.content.includes("$$BIG_LOG$$")
      ? { ...m, content: m.content.replace("$$BIG_LOG$$", bigLog) }
      : m
  );
}

function interleaveResponses(actorOuts: unknown[], judgeOuts: unknown[]): string[] {
  const out: string[] = [];
  const pairs = Math.max(actorOuts.length, judgeOuts.length);
  for (let i = 0; i < pairs; i++) {
    if (i < actorOuts.length) out.push(JSON.stringify(actorOuts[i]));
    if (i < judgeOuts.length) out.push(JSON.stringify(judgeOuts[i]));
  }
  return out;
}

function makeSkill(s: FixtureSkill): ParsedSkill {
  return {
    name: s.name,
    filePath: `/virtual/${s.name}/SKILL.md`,
    rawModel: undefined,
    instructions: s.instructions,
  };
}

function settingsForFixture(f: Fixture): RouterSettings {
  return {
    ...DEFAULT_SETTINGS,
    // History window large enough that the /skill message is always included.
    historyWindow: Math.max(DEFAULT_SETTINGS.historyWindow, f.messages.length),
    maxJudgeIterations: Math.max(f.expected.iterations, 2),
    routingTimeoutMs: 0,
  };
}

describe("long-session regression fixtures", () => {
  const fixtures = loadFixtures();

  it("loads at least 3 long-session fixtures", () => {
    assert.ok(
      fixtures.length >= 3,
      `expected ≥3 fixtures, found ${fixtures.length}`
    );
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      const history = fixture.expected.expandLargeLogPlaceholder
        ? expandPlaceholders(fixture.messages)
        : fixture.messages;
      const settings = settingsForFixture(fixture);

      it("runs Actor/Judge deterministically and matches expected outcome", async () => {
        const { host } = createFakeHost({
          history,
          llmResponses: interleaveResponses(
            fixture.actorOutputs,
            fixture.judgeOutputs
          ),
        });
        const outcome = await runActorJudgeLoop(
          host,
          settings,
          makeSkill(fixture.skill)
        );

        assert.equal(
          outcome.passed,
          fixture.expected.rubricPassed,
          `rubric passed mismatch for ${fixture.name}`
        );
        assert.equal(
          outcome.iterations,
          fixture.expected.iterations,
          `iteration count mismatch for ${fixture.name}`
        );
        assert.equal(
          outcome.route.tier,
          fixture.expected.routeTier,
          `route tier mismatch for ${fixture.name}`
        );
        assert.ok(
          TIER_RANK[outcome.route.tier] >=
            TIER_RANK[fixture.expected.minRouteTier],
          `route tier ${outcome.route.tier} below floor ${fixture.expected.minRouteTier}`
        );
        if (typeof fixture.expected.minJudgeConfidence === "number") {
          assert.ok(
            outcome.route.confidence >= fixture.expected.minJudgeConfidence,
            `confidence ${outcome.route.confidence} below ${fixture.expected.minJudgeConfidence}`
          );
        }

        // Brief shape invariants.
        assert.equal(typeof outcome.brief.userGoal, "string");
        assert.ok(Array.isArray(outcome.brief.constraints));
        assert.equal(typeof outcome.brief.knownContext, "string");

        for (const kw of fixture.expected.briefGoalKeywords ?? []) {
          assert.ok(
            outcome.brief.userGoal.includes(kw),
            `expected userGoal to mention "${kw}", got: ${outcome.brief.userGoal}`
          );
        }
        for (const kw of fixture.expected.briefContextKeywords ?? []) {
          assert.ok(
            outcome.brief.knownContext.includes(kw),
            `expected knownContext to mention "${kw}"`
          );
        }

        if (fixture.expected.expectClarificationQuestion) {
          assert.ok(
            outcome.iterations > 1,
            "expected the loop to have re-prompted after a failed first pass"
          );
        }
      });

      it("Actor and Judge outputs both parse as JSON across the loop", async () => {
        const { host, llmCalls } = createFakeHost({
          history,
          llmResponses: interleaveResponses(
            fixture.actorOutputs,
            fixture.judgeOutputs
          ),
        });
        await runActorJudgeLoop(host, settings, makeSkill(fixture.skill));
        // Each iteration produces 2 LLM calls (actor + judge).
        assert.equal(
          llmCalls.length,
          fixture.expected.iterations * 2,
          `expected ${fixture.expected.iterations * 2} LLM calls`
        );
        // Routing prompts must be json-mode for deterministic parsing.
        for (const call of llmCalls) {
          assert.equal(call.responseFormat, "json");
        }
      });
    });
  }
});
