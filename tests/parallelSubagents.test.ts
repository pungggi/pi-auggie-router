import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runParallelSubagents } from "../src/parallelSubagents.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import type {
  ParsedSkill,
  PiHost,
  RouterSettings,
  SubAgentResult,
  SubAgentRunOptions,
  SubtaskBrief,
} from "../src/types.ts";

function makeSkill(): ParsedSkill {
  return {
    name: "demo",
    filePath: "/tmp/skill",
    rawModel: undefined,
    instructions: "Do it.",
  };
}

interface HostHooks {
  onRun?: (opts: SubAgentRunOptions, idx: number) => Promise<SubAgentResult>;
}

function makeHost(hooks: HostHooks = {}): {
  host: PiHost;
  calls: SubAgentRunOptions[];
  concurrentMax: { value: number };
} {
  const calls: SubAgentRunOptions[] = [];
  const concurrentMax = { value: 0 };
  let inflight = 0;
  const host: PiHost = {
    postSystemMessage: () => {},
    postAssistantMessage: () => {},
    setInputLocked: () => {},
    getRecentMessages: () => [],
    callLLM: async () => ({ text: "" }),
    runSubAgent: async (opts) => {
      const idx = calls.length;
      calls.push(opts);
      inflight++;
      if (inflight > concurrentMax.value) concurrentMax.value = inflight;
      try {
        if (hooks.onRun) return await hooks.onRun(opts, idx);
        return { finalText: `out-${idx}`, stoppedReason: "completed" };
      } finally {
        inflight--;
      }
    },
    onBeforeMessage: () => () => {},
    onUserInput: () => () => {},
    resolveWorkspacePath: (rel) => rel,
    resolveHomePath: (rel) => rel,
  };
  return { host, calls, concurrentMax };
}

function enableParallel(
  overrides: Partial<RouterSettings["parallelSubagents"]> = {}
): RouterSettings {
  return {
    ...DEFAULT_SETTINGS,
    parallelSubagents: {
      ...DEFAULT_SETTINGS.parallelSubagents,
      enabled: true,
      maxSubagents: 3,
      perWorkerOutputCharCap: 0,
      ...overrides,
    },
  };
}

const briefs: SubtaskBrief[] = [
  { id: "w1", goal: "investigate module A" },
  { id: "w2", goal: "investigate module B" },
  { id: "w3", goal: "investigate module C" },
];

describe("runParallelSubagents", () => {
  it("throws when feature is disabled", async () => {
    const { host } = makeHost();
    await assert.rejects(
      () =>
        runParallelSubagents(host, DEFAULT_SETTINGS, {
          skill: makeSkill(),
          resolvedModel: "openrouter/x/y",
          subtasks: [{ id: "a", goal: "go" }],
        }),
      /enabled=false/
    );
  });

  it("returns empty result for empty subtasks", async () => {
    const { host, calls } = makeHost();
    const result = await runParallelSubagents(host, enableParallel(), {
      skill: makeSkill(),
      resolvedModel: "openrouter/x/y",
      subtasks: [],
    });
    assert.deepEqual(result.workers, []);
    assert.equal(result.synthesizedText, "");
    assert.equal(calls.length, 0);
  });

  it("rejects duplicate subtask ids", async () => {
    const { host } = makeHost();
    await assert.rejects(
      () =>
        runParallelSubagents(host, enableParallel(), {
          skill: makeSkill(),
          resolvedModel: "openrouter/x/y",
          subtasks: [
            { id: "dup", goal: "g1" },
            { id: "dup", goal: "g2" },
          ],
        }),
      /duplicate subtask\.id "dup"/
    );
  });

  it("runs each subtask once and preserves input order in output", async () => {
    const { host, calls } = makeHost();
    const result = await runParallelSubagents(host, enableParallel(), {
      skill: makeSkill(),
      resolvedModel: "openrouter/x/y",
      subtasks: briefs,
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(
      result.workers.map((w) => w.id),
      ["w1", "w2", "w3"]
    );
    for (const w of result.workers) {
      assert.equal(w.stoppedReason, "completed");
      assert.equal(w.truncated, false);
    }
  });

  it("enforces maxConcurrency bounded by settings cap", async () => {
    const gates: Array<() => void> = [];
    const { host, concurrentMax } = makeHost({
      onRun: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { finalText: "ok", stoppedReason: "completed" };
      },
    });
    const promise = runParallelSubagents(host, enableParallel({ maxSubagents: 2 }), {
      skill: makeSkill(),
      resolvedModel: "openrouter/x/y",
      // Try to override above the settings cap — runner must clamp to 2.
      maxConcurrency: 10,
      subtasks: briefs,
    });
    // Spin the event loop until the runner has launched as many workers as
    // it intends to before we release any of them.
    while (gates.length < 2) await new Promise((r) => setImmediate(r));
    assert.equal(concurrentMax.value, 2, "settings cap must clamp the override");
    assert.equal(gates.length, 2, "third worker waits for a free lane");
    // Drain.
    while (gates.length > 0) {
      const g = gates.shift();
      g?.();
      await new Promise((r) => setImmediate(r));
    }
    await promise;
  });

  it("clips per-worker output beyond cap and marks truncated", async () => {
    const { host } = makeHost({
      onRun: async () => ({
        finalText: "x".repeat(5_000),
        stoppedReason: "completed",
      }),
    });
    const result = await runParallelSubagents(
      host,
      enableParallel({ perWorkerOutputCharCap: 100 }),
      {
        skill: makeSkill(),
        resolvedModel: "openrouter/x/y",
        subtasks: [{ id: "w1", goal: "g" }],
      }
    );
    const w = result.workers[0]!;
    assert.equal(w.truncated, true);
    assert.equal(w.stoppedReason, "cap");
    assert.ok(w.text.length <= 100);
    assert.match(w.text, /worker output truncated/);
  });

  it("captures worker failure as stoppedReason=error without cancelling siblings", async () => {
    const { host } = makeHost({
      onRun: async (_opts, idx) => {
        if (idx === 0) throw new Error("retrieval blew up");
        return { finalText: `ok-${idx}`, stoppedReason: "completed" };
      },
    });
    const result = await runParallelSubagents(host, enableParallel(), {
      skill: makeSkill(),
      resolvedModel: "openrouter/x/y",
      subtasks: briefs,
    });
    assert.equal(result.workers[0]!.stoppedReason, "error");
    assert.match(result.workers[0]!.error ?? "", /retrieval blew up/);
    assert.equal(result.workers[1]!.stoppedReason, "completed");
    assert.equal(result.workers[2]!.stoppedReason, "completed");
    assert.match(result.synthesizedText, /Worker failed: retrieval blew up/);
  });

  it("synthesizer combines worker outputs deterministically", async () => {
    const { host } = makeHost();
    const result = await runParallelSubagents(host, enableParallel(), {
      skill: makeSkill(),
      resolvedModel: "openrouter/x/y",
      subtasks: briefs,
    });
    assert.match(result.synthesizedText, /## Parallel sub-agent synthesis/);
    assert.match(result.synthesizedText, /### w1 — investigate module A/);
    assert.match(result.synthesizedText, /### w2 — investigate module B/);
    assert.match(result.synthesizedText, /### w3 — investigate module C/);
    // Order matches input order.
    const i1 = result.synthesizedText.indexOf("### w1");
    const i2 = result.synthesizedText.indexOf("### w2");
    const i3 = result.synthesizedText.indexOf("### w3");
    assert.ok(i1 < i2 && i2 < i3);
  });

  it("system prompt is byte-stable across workers (cache-friendly)", async () => {
    const { host, calls } = makeHost();
    await runParallelSubagents(host, enableParallel(), {
      skill: makeSkill(),
      resolvedModel: "openrouter/x/y",
      subtasks: briefs,
    });
    const prompts = calls.map((c) => c.systemPrompt);
    assert.equal(new Set(prompts).size, 1, "all workers share one system prompt");
    // Subtask data must NOT enter the system prompt (Action 5 invariant).
    for (const b of briefs) {
      for (const p of prompts) assert.ok(!p.includes(b.id));
    }
  });

  it("subtask data lands in user prompt only", async () => {
    const { host, calls } = makeHost();
    await runParallelSubagents(host, enableParallel(), {
      skill: makeSkill(),
      resolvedModel: "openrouter/x/y",
      subtasks: [
        {
          id: "w1",
          goal: "compare A and B",
          scope: "src/a vs src/b",
          retrievalHints: ["packageA", "packageB"],
          outputSchema: "JSON",
        },
      ],
    });
    const opts = calls[0]!;
    assert.match(opts.userPrompt, /Subtask ID: w1/);
    assert.match(opts.userPrompt, /Goal: compare A and B/);
    assert.match(opts.userPrompt, /Scope: src\/a vs src\/b/);
    assert.match(opts.userPrompt, /packageA/);
    assert.match(opts.userPrompt, /Output format: JSON/);
  });
});
