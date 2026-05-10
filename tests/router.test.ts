import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../src/index.ts";
import type {
  ChatMessage,
  LLMCallOptions,
  PiHost,
  SubAgentRunOptions,
  SubAgentResult,
} from "../src/types.ts";

interface HarnessOpts {
  llmResponses: string[];
  preflightOk?: boolean;
  preflightDetail?: string;
  subAgentResult?: SubAgentResult;
  history?: ChatMessage[];
  /** Override settings via .pi/settings.json. */
  settingsOverride?: Record<string, unknown>;
  /** When set, callLLM resolves after this many ms — and respects abort. */
  llmDelayMs?: number;
  /**
   * Misbehaving host: callLLM ignores the AbortSignal entirely. Used to
   * verify that callWithTimeout's Promise.race short-circuits regardless.
   */
  ignoreSignal?: boolean;
}

function harness(opts: HarnessOpts) {
  const workspace = mkdtempSync(join(tmpdir(), "pi-router-ws-"));
  const home = mkdtempSync(join(tmpdir(), "pi-router-home-"));

  if (opts.settingsOverride) {
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(
      join(workspace, ".pi", "settings.json"),
      JSON.stringify({ auggieRouter: opts.settingsOverride })
    );
  }

  const messages: { kind: "system" | "assistant"; text: string }[] = [];
  const lockEvents: { locked: boolean; reason?: string }[] = [];
  const llmCalls: LLMCallOptions[] = [];
  const subAgentCalls: SubAgentRunOptions[] = [];
  const logs: { level: string; msg: string }[] = [];

  let inputCb: ((raw: string) => { cancel: boolean } | void) | null = null;
  let beforeCb: ((msg: string) => { cancel: boolean }) | null = null;

  let i = 0;
  const host: PiHost = {
    postSystemMessage: (text) => messages.push({ kind: "system", text }),
    postAssistantMessage: (text) => messages.push({ kind: "assistant", text }),
    setInputLocked: (locked, reason) => lockEvents.push({ locked, reason }),
    getRecentMessages: () => opts.history ?? [],
    callLLM: async (o) => {
      llmCalls.push(o);
      const t = opts.llmResponses[i] ?? "";
      i += 1;
      if (opts.llmDelayMs && opts.llmDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.llmDelayMs);
          if (!opts.ignoreSignal) {
            o.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          }
        });
      }
      return { text: t };
    },
    runSubAgent: async (o) => {
      subAgentCalls.push(o);
      return (
        opts.subAgentResult ?? { finalText: "DONE", stoppedReason: "completed" }
      );
    },
    onBeforeMessage: (cb) => {
      beforeCb = cb;
      return () => {
        beforeCb = null;
      };
    },
    onUserInput: (cb) => {
      inputCb = cb;
      return () => {
        inputCb = null;
      };
    },
    resolveWorkspacePath: (rel) => join(workspace, rel),
    resolveHomePath: (rel) => join(home, rel),
    log: (level, msg) => logs.push({ level, msg }),
  };

  return {
    host,
    workspace,
    home,
    messages,
    lockEvents,
    llmCalls,
    subAgentCalls,
    logs,
    fireInput: (raw: string) => inputCb?.(raw),
    fireBefore: (msg: string) => beforeCb?.(msg),
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
    preflight: async () => ({
      ok: opts.preflightOk ?? true,
      detail: opts.preflightDetail ?? "",
    }),
  };
}

function writeSkill(workspace: string, name: string, body: string): void {
  const dir = join(workspace, ".pi", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

const PASSING_LLM_PAIR = [
  JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }),
  JSON.stringify({
    hasUserGoal: true,
    hasRequiredInputs: true,
    hasScopeBoundary: true,
    isUnambiguous: true,
  }),
];

function passingPairWithRoute(route: Record<string, unknown>): string[] {
  return [
    JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }),
    JSON.stringify({
      hasUserGoal: true,
      hasRequiredInputs: true,
      hasScopeBoundary: true,
      isUnambiguous: true,
      executionRoute: route,
    }),
  ];
}

const CHEAP_READ_ONLY_ROUTE: Record<string, unknown> = {
  tier: "cheap",
  complexity: "low",
  risk: "read_only",
  confidence: 0.9,
  reason: "Read-only lookup task.",
};

const ADAPTIVE_ROUTING_SETTINGS = {
  executionRouting: {
    enabled: true,
    preference: "balanced",
    surfaceDecision: false,
    skillModelPolicy: "pin",
    models: {
      cheap: "openrouter/test/cheap",
      balanced: "openrouter/test/balanced",
      frontier: "openrouter/test/frontier",
    },
  },
};

describe("createRouter end-to-end", () => {
  it("routes /skill: through Actor/Judge → sub-agent and posts result", async () => {
    const h = harness({ llmResponses: [...PASSING_LLM_PAIR] });
    try {
      writeSkill(
        h.workspace,
        "demo",
        "---\nmodel: claude-3-7-sonnet\n---\nDo the demo."
      );
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const sub = h.subAgentCalls[0]!;
      assert.equal(sub.model, "openrouter/anthropic/claude-3-7-sonnet");
      assert.equal(sub.temperature, 0);
      assert.equal(sub.mcpServers[0]!.name, "auggie");
      assert.match(sub.systemPrompt, /codebase-retrieval/);
      assert.equal(sub.totalTimeoutMs, 300_000);
      assert.equal(sub.inactivityTimeoutMs, 60_000);

      const assistant = h.messages.find((m) => m.kind === "assistant");
      assert.equal(assistant?.text, "DONE");

      assert.deepEqual(
        h.lockEvents.map((e) => e.locked),
        [true, false]
      );
    } finally {
      h.cleanup();
    }
  });

  it("aborts with system error when auggie pre-flight fails", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      preflightOk: false,
      preflightDetail: "daemon not running",
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.subAgentCalls.length, 0);
      const sys = h.messages.find((m) =>
        m.text.includes("Augment daemon is offline")
      );
      assert.ok(sys, "expected pre-flight error system message");
    } finally {
      h.cleanup();
    }
  });

  it("falls back to Q&A and resumes after the user replies", async () => {
    const failingPair = [
      JSON.stringify({ userGoal: "", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Which file?",
      }),
    ];
    const h = harness({
      llmResponses: [...failingPair, ...failingPair],
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });

      const triggered = router.trigger("/skill:demo");

      // Allow the loop to reach the Q&A pause; node:test resolves microtasks
      // synchronously between awaits so we yield once.
      await new Promise((r) => setImmediate(r));

      const ask = h.messages.find((m) =>
        m.text.includes("Missing context for skill")
      );
      assert.ok(ask, "expected Q&A prompt");
      assert.match(ask!.text, /Which file\?/);

      // User answers; the before-message hook should swallow it.
      const swallow = h.fireBefore("src/utils.ts");
      assert.deepEqual(swallow, { cancel: true });

      await triggered;

      assert.equal(h.subAgentCalls.length, 1);
      const sub = h.subAgentCalls[0]!;
      assert.match(sub.userPrompt, /src\/utils\.ts/);
    } finally {
      h.cleanup();
    }
  });

  it("rejects unknown skill names with a friendly system message", async () => {
    const h = harness({ llmResponses: [] });
    try {
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:does-not-exist");
      const sys = h.messages.find((m) =>
        m.text.includes('Skill "does-not-exist" not found')
      );
      assert.ok(sys);
      assert.equal(h.subAgentCalls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it("intercepts /skill: input and cancels host default handling", async () => {
    const h = harness({ llmResponses: [...PASSING_LLM_PAIR] });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      createRouter(h.host, { preflight: h.preflight });
      const result = h.fireInput("/skill:demo do something");
      assert.deepEqual(result, { cancel: true });

      // Non-skill input is left alone.
      const passthrough = h.fireInput("hello world");
      assert.equal(passthrough, undefined);
    } finally {
      h.cleanup();
    }
  });

  it("router.trigger throws on input that doesn't match the /skill: regex", async () => {
    const h = harness({ llmResponses: [] });
    try {
      const router = createRouter(h.host, { preflight: h.preflight });
      // `..` contains a `.`, which the chat regex rejects up-front.
      await assert.rejects(() => router.trigger("/skill:../etc"));
    } finally {
      h.cleanup();
    }
  });

  it("truncates long auggie stderr in the system error message", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      preflightOk: false,
      preflightDetail: "x".repeat(1000) + "\nsecret-token-abcdef",
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");
      const err = h.messages.find((m) =>
        m.text.includes("Augment daemon is offline")
      );
      assert.ok(err);
      // Truncated to 200 chars and newlines collapsed.
      assert.ok(
        err!.text.length < 400,
        `expected truncated message, got ${err!.text.length} chars`
      );
      assert.ok(!err!.text.includes("\n\n"));
    } finally {
      h.cleanup();
    }
  });

  it("times out the Q&A wait after qaTimeoutMs and unlocks the router", async () => {
    const failingPair = [
      JSON.stringify({ userGoal: "", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Which file?",
      }),
    ];
    const h = harness({
      llmResponses: [...failingPair, ...failingPair],
      settingsOverride: { qaTimeoutMs: 25 },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const cancelled = h.messages.find((m) => m.text.includes("Q&A timed out"));
      assert.ok(cancelled, "expected timeout system message");
      assert.equal(h.subAgentCalls.length, 0);

      // Router must be free to accept a new skill afterwards.
      writeSkill(h.workspace, "demo2", "Do it.");
      // reset the harness LLM cursor by reusing the same mock — `i` keeps
      // counting, so feed enough responses up front by using a fresh harness
      // is cleaner for true follow-up tests; here we just assert idle.
      assert.deepEqual(
        h.lockEvents.map((e) => e.locked),
        [],
        "input should never have been locked because execution did not start"
      );
    } finally {
      h.cleanup();
    }
  });

  it("a second user message during Q&A resume falls through (race guard)", async () => {
    const failingPair = [
      JSON.stringify({ userGoal: "", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Which file?",
      }),
    ];
    const h = harness({
      llmResponses: [...failingPair, ...failingPair],
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      const triggered = router.trigger("/skill:demo");
      await new Promise((r) => setImmediate(r));

      const first = h.fireBefore("src/utils.ts");
      assert.deepEqual(first, { cancel: true });

      // Second message arrives in the same tick; must NOT be swallowed.
      const second = h.fireBefore("but actually nevermind");
      assert.deepEqual(second, { cancel: false });

      await triggered;
      assert.equal(h.subAgentCalls.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it("does not hang when the host ignores AbortSignal — Promise.race wins", async () => {
    // 5s of slow work but a 25ms routing timeout AND an ignore-signal host:
    // a non-racing implementation would await the full 5s and fail the test
    // (the test runner's per-test timeout would actually fire first). With
    // Promise.race the timeout branch resolves at 25ms and the test wraps
    // in well under a second.
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR, ...PASSING_LLM_PAIR],
      settingsOverride: { routingTimeoutMs: 25, qaTimeoutMs: 25 },
      llmDelayMs: 5_000,
      ignoreSignal: true,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      const start = Date.now();
      await router.trigger("/skill:demo");
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < 1000,
        `expected timeout to short-circuit, took ${elapsed}ms`
      );
      // Q&A is also capped, so the loop ends in cancellation.
      const cancelled = h.messages.find((m) => m.text.includes("Q&A timed out"));
      assert.ok(cancelled, "expected Q&A timeout cancel message");
      assert.equal(h.subAgentCalls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it("aborts an Actor LLM call that exceeds routingTimeoutMs", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR, ...PASSING_LLM_PAIR],
      // Cap Q&A too so the test doesn't hang on the fallback prompt.
      settingsOverride: { routingTimeoutMs: 25, qaTimeoutMs: 25 },
      llmDelayMs: 200,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      // Both passes time out → judge fallback rubric → Q&A surfaces.
      const ask = h.messages.find((m) =>
        m.text.includes("Missing context for skill")
      );
      assert.ok(ask);
      assert.match(ask!.text, /Routing model timed out/);

      // The router should have walked the loop with abort signals attached.
      assert.ok(h.llmCalls.length >= 2);
      assert.ok(h.llmCalls.every((c) => c.signal !== undefined));
    } finally {
      h.cleanup();
    }
  });

  // --- Phase 4+5: adaptive execution routing integration tests ---

  it("uses adaptive model selection when executionRouting enabled", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: ADAPTIVE_ROUTING_SETTINGS,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.subAgentCalls.length, 1);
      assert.equal(
        h.subAgentCalls[0]!.model,
        "openrouter/test/cheap",
        "should use cheap pool model"
      );
    } finally {
      h.cleanup();
    }
  });

  it("surfaces routing decision in system message when surfaceDecision is true", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: {
        ...ADAPTIVE_ROUTING_SETTINGS,
        executionRouting: {
          ...ADAPTIVE_ROUTING_SETTINGS.executionRouting,
          surfaceDecision: true,
        },
      },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const sys = h.messages.find((m) =>
        m.text.includes("using cheap model")
      );
      assert.ok(sys, "expected surfaced routing decision");
      assert.match(sys!.text, /openrouter\/test\/cheap/);
      assert.match(sys!.text, /route cheap/);
      assert.ok(!sys!.text.includes("Read-only lookup task."));
    } finally {
      h.cleanup();
    }
  });

  it("keeps minimal execution message when surfaceDecision is false", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: ADAPTIVE_ROUTING_SETTINGS,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const sys = h.messages.find((m) =>
        m.text.includes("⚙️ Executing /skill:demo")
      );
      assert.ok(sys, "expected execution message");
      assert.match(
        sys!.text,
        /Auggie semantic retrieval running/,
        "should use minimal format"
      );
      assert.ok(
        !sys!.text.includes("using cheap model"),
        "should not surface routing details"
      );
    } finally {
      h.cleanup();
    }
  });

  it("emits structured route log", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: ADAPTIVE_ROUTING_SETTINGS,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const entry = h.logs.find((l) => l.msg.includes("auggie-router.execution-route"));
      assert.ok(entry, "expected structured route log");
      assert.equal(entry.level, "info");
      const data = JSON.parse(entry.msg);
      assert.equal(data.event, "auggie-router.execution-route");
      assert.equal(data.skill, "demo");
      assert.equal(data.tier, "cheap");
      assert.equal(data.model, "openrouter/test/cheap");
      assert.equal(data.source, "execution-routing");
      assert.equal(data.complexity, "low");
      assert.equal(data.risk, "read_only");
      assert.equal(data.confidence, 0.9);
      assert.equal(data.routeTier, "cheap");
      assert.equal(data.effectiveTier, "cheap");
    } finally {
      h.cleanup();
    }
  });

  it("does not inject route metadata into sub-agent system prompt", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: ADAPTIVE_ROUTING_SETTINGS,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.subAgentCalls.length, 1);
      const sp = h.subAgentCalls[0]!.systemPrompt;
      // Route metadata must not leak into the sub-agent prompt.
      assert.ok(!sp.includes("execution-route"), "no event name");
      assert.ok(!sp.includes("openrouter/test/cheap"), "no model id");
      assert.ok(!sp.includes("tier"), "no tier keyword");
      assert.ok(!sp.includes("read_only"), "no risk value");
      // Prompt should still contain the expected deterministic parts.
      assert.match(sp, /codebase-retrieval/);
    } finally {
      h.cleanup();
    }
  });

  it("surfaces pinned skill model when surfaceDecision is true", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: {
        ...ADAPTIVE_ROUTING_SETTINGS,
        executionRouting: {
          ...ADAPTIVE_ROUTING_SETTINGS.executionRouting,
          surfaceDecision: true,
        },
      },
    });
    try {
      writeSkill(
        h.workspace,
        "demo",
        "---\nmodel: claude-3-7-sonnet\n---\nDo it."
      );
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.subAgentCalls.length, 1);
      assert.equal(
        h.subAgentCalls[0]!.model,
        "openrouter/anthropic/claude-3-7-sonnet",
        "should use pinned skill model, not pool"
      );
      const sys = h.messages.find((m) =>
        m.text.includes("using SKILL.md model")
      );
      assert.ok(sys, "expected surfaced pinned model decision");
      assert.match(sys!.text, /openrouter\/anthropic\/claude-3-7-sonnet/);
      assert.ok(!sys!.text.includes("using balanced model"));
    } finally {
      h.cleanup();
    }
  });

  it("ignores skill model when skillModelPolicy is ignore", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: {
        ...ADAPTIVE_ROUTING_SETTINGS,
        executionRouting: {
          ...ADAPTIVE_ROUTING_SETTINGS.executionRouting,
          skillModelPolicy: "ignore",
        },
      },
    });
    try {
      writeSkill(
        h.workspace,
        "demo",
        "---\nmodel: claude-3-7-sonnet\n---\nDo it."
      );
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.subAgentCalls.length, 1);
      assert.equal(
        h.subAgentCalls[0]!.model,
        "openrouter/test/cheap",
        "should use pool model, ignoring skill model"
      );
    } finally {
      h.cleanup();
    }
  });

  it("keeps unpassed judge route at least balanced even under preferCheap", async () => {
    const failJudgeCheap = [
      JSON.stringify({ userGoal: "", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Which file?",
        executionRoute: {
          tier: "cheap",
          complexity: "medium",
          risk: "read_only",
          confidence: 0.95,
          reason: "Read-only task.",
        },
      }),
      // Second iteration after Q&A also fails → judge fallback rubric.
      JSON.stringify({ userGoal: "g", constraints: [], knownContext: "" }),
      JSON.stringify({
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: "Which file?",
        executionRoute: {
          tier: "cheap",
          complexity: "medium",
          risk: "read_only",
          confidence: 0.95,
          reason: "Read-only task.",
        },
      }),
    ];
    const h = harness({
      llmResponses: failJudgeCheap,
      settingsOverride: {
        ...ADAPTIVE_ROUTING_SETTINGS,
        executionRouting: {
          ...ADAPTIVE_ROUTING_SETTINGS.executionRouting,
          preference: "preferCheap",
        },
      },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      const triggered = router.trigger("/skill:demo");
      await new Promise((r) => setImmediate(r));
      h.fireBefore("src/utils.ts");
      await triggered;

      // Judge never passed → Q&A answered → execution proceeds.
      // Even though maxJudgeIterations exhausted, execution still starts.
      // The cheap route should be bumped to balanced.
      assert.equal(h.subAgentCalls.length, 1);
      assert.equal(
        h.subAgentCalls[0]!.model,
        "openrouter/test/balanced",
        "cheap route should stay at least balanced when judge did not pass"
      );
      const entry = h.logs.find((l) => l.msg.includes("auggie-router.execution-route"));
      assert.ok(entry, "expected structured route log");
      const data = JSON.parse(entry.msg);
      assert.equal(data.routeTier, "cheap");
      assert.equal(data.effectiveTier, "balanced");
      assert.equal(data.tier, "balanced");
    } finally {
      h.cleanup();
    }
  });

  it("preserves existing model resolution when executionRouting is disabled", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      // No settingsOverride → defaults (executionRouting.enabled: false)
    });
    try {
      writeSkill(
        h.workspace,
        "demo",
        "---\nmodel: claude-3-7-sonnet\n---\nDo it."
      );
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.subAgentCalls.length, 1);
      assert.equal(
        h.subAgentCalls[0]!.model,
        "openrouter/anthropic/claude-3-7-sonnet",
        "should use skill model exactly as before"
      );

      // Message should be the standard format.
      const sys = h.messages.find((m) =>
        m.text.includes("⚙️ Executing /skill:demo")
      );
      assert.ok(sys);
      assert.match(sys!.text, /Auggie semantic retrieval running/);
    } finally {
      h.cleanup();
    }
  });

  // --- output sanitizer integration -----------------------------------------

  it("sanitizes final text and emits output-sanitized log when traces present", async () => {
    const dirty =
      "Here's the answer.\n\n```tool_result\n{\"leak\":\"blob\"}\n```\n\nFinal line.";
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      subAgentResult: { finalText: dirty, stoppedReason: "completed" },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const assistant = h.messages.find((m) => m.kind === "assistant");
      assert.ok(assistant, "expected assistant message");
      assert.ok(!assistant!.text.includes("leak"), "leaked tool_result content");
      assert.ok(assistant!.text.includes("Final line."));

      const log = h.logs.find((l) => l.msg.includes("auggie-router.output-sanitized"));
      assert.ok(log, "expected sanitizer log entry");
      const data = JSON.parse(log!.msg);
      assert.equal(data.event, "auggie-router.output-sanitized");
      assert.equal(data.skill, "demo");
      assert.equal(data.removedSections, 1);
      assert.equal(data.truncated, false);
      assert.ok(data.originalChars > data.finalChars);
    } finally {
      h.cleanup();
    }
  });

  it("does not emit output-sanitized log for clean answers", async () => {
    const clean = "Plain answer.\n\n```ts\nconst x = 1;\n```\n\nDone.";
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      subAgentResult: { finalText: clean, stoppedReason: "completed" },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const assistant = h.messages.find((m) => m.kind === "assistant");
      assert.equal(assistant?.text, clean, "clean answer must pass through unchanged");

      const log = h.logs.find((l) => l.msg.includes("auggie-router.output-sanitized"));
      assert.equal(log, undefined, "no sanitizer log for clean output");
    } finally {
      h.cleanup();
    }
  });

  it("respects outputSanitizer.enabled=false", async () => {
    const dirty = "Pre\n```tool_result\nKEEP\n```\nPost";
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      subAgentResult: { finalText: dirty, stoppedReason: "completed" },
      settingsOverride: {
        outputSanitizer: { enabled: false, finalOutputMaxChars: 0, stripToolTraces: true },
      },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const assistant = h.messages.find((m) => m.kind === "assistant");
      assert.equal(assistant?.text, dirty, "sanitizer disabled — passthrough");
      const log = h.logs.find((l) => l.msg.includes("auggie-router.output-sanitized"));
      assert.equal(log, undefined);
    } finally {
      h.cleanup();
    }
  });

  // --- debugPromptPrefixHash --------------------------------------------------

  it("emits prompt-prefix hash log when debugPromptPrefixHash is enabled", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      settingsOverride: { debugPromptPrefixHash: true },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const log = h.logs.find((l) => l.msg.includes("auggie-router.prompt-prefix"));
      assert.ok(log, "expected prompt-prefix hash log");
      assert.equal(log!.level, "debug");
      const data = JSON.parse(log!.msg);
      assert.equal(data.event, "auggie-router.prompt-prefix");
      assert.equal(data.skill, "demo");
      assert.equal(typeof data.sha256, "string");
      assert.match(data.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isInteger(data.bytes) && data.bytes > 0);
      // Hash log must NEVER contain the prompt text itself.
      assert.ok(!log!.msg.includes("codebase-retrieval"));
    } finally {
      h.cleanup();
    }
  });

  it("does not emit prompt-prefix log when debugPromptPrefixHash is disabled", async () => {
    const h = harness({ llmResponses: [...PASSING_LLM_PAIR] });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const log = h.logs.find((l) => l.msg.includes("auggie-router.prompt-prefix"));
      assert.equal(log, undefined);
    } finally {
      h.cleanup();
    }
  });

  // --- Action 4: context budgets by tier ------------------------------------

  it("emits context-budget log and uses cheap-tier ceiling when enabled", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: {
        ...ADAPTIVE_ROUTING_SETTINGS,
        overflowCeilingBytes: 25_000,
        contextBudgets: {
          enabled: true,
          overflowCeilingBytes: { cheap: 9_000, balanced: 25_000, frontier: 50_000 },
        },
      },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const log = h.logs.find((l) => l.msg.includes("auggie-router.context-budget"));
      assert.ok(log, "expected context-budget log");
      assert.equal(log!.level, "info");
      const data = JSON.parse(log!.msg);
      assert.equal(data.event, "auggie-router.context-budget");
      assert.equal(data.skill, "demo");
      assert.equal(data.tier, "cheap");
      assert.equal(data.overflowCeilingBytes, 9_000);
      assert.equal(data.source, "tier");
      // Log must NOT contain raw user content or prompts.
      assert.ok(!log!.msg.includes("Do it."));
    } finally {
      h.cleanup();
    }
  });

  it("does not emit context-budget log when disabled (legacy behaviour)", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: ADAPTIVE_ROUTING_SETTINGS,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const log = h.logs.find((l) => l.msg.includes("auggie-router.context-budget"));
      assert.equal(log, undefined);
    } finally {
      h.cleanup();
    }
  });

  it("falls back to top-level ceiling when tier value missing", async () => {
    const h = harness({
      llmResponses: passingPairWithRoute(CHEAP_READ_ONLY_ROUTE),
      settingsOverride: {
        ...ADAPTIVE_ROUTING_SETTINGS,
        overflowCeilingBytes: 33_000,
        contextBudgets: {
          enabled: true,
          // Intentionally omit `cheap`.
          overflowCeilingBytes: { balanced: 25_000, frontier: 50_000 },
        },
      },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const log = h.logs.find((l) => l.msg.includes("auggie-router.context-budget"));
      assert.ok(log);
      const data = JSON.parse(log!.msg);
      assert.equal(data.source, "tier-fallback");
      assert.equal(data.overflowCeilingBytes, 33_000);
    } finally {
      h.cleanup();
    }
  });
});
