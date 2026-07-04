import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../src/index.ts";
import type {
  ChatMessage,
  CompactionEvent,
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
  /** When true the host exposes `onCompaction` (Pi >= 0.79.10). */
  withCompaction?: boolean;
  /** Per-call error injection: callLLM #n rejects with llmErrors[n] if set. */
  llmErrors?: (Error | undefined)[];
  /** When set the host exposes `getMode` (Pi >= 0.78.1 ctx.mode). */
  mode?: string;
  /** When set the host exposes `getSystemPromptOptions` (Pi >= 0.78.1). */
  systemPromptOptions?: { systemPrompt?: string; customInstructions?: string };
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

  let inputCb: ((raw: string) => { cancel: boolean } | void) | null = null;
  let beforeCb: ((msg: string) => { cancel: boolean }) | null = null;
  let compactionCb: ((event: CompactionEvent) => void) | null = null;

  let i = 0;
  const host: PiHost = {
    postSystemMessage: (text) => messages.push({ kind: "system", text }),
    postAssistantMessage: (text) => messages.push({ kind: "assistant", text }),
    setInputLocked: (locked, reason) => lockEvents.push({ locked, reason }),
    getRecentMessages: () => opts.history ?? [],
    callLLM: async (o) => {
      llmCalls.push(o);
      const idx = i;
      const t = opts.llmResponses[idx] ?? "";
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
      const err = opts.llmErrors?.[idx];
      if (err) throw err;
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
  };

  if (opts.mode !== undefined) {
    host.getMode = () => opts.mode!;
  }
  if (opts.systemPromptOptions !== undefined) {
    host.getSystemPromptOptions = () => opts.systemPromptOptions!;
  }

  if (opts.withCompaction) {
    host.onCompaction = (cb) => {
      compactionCb = cb;
      return () => {
        compactionCb = null;
      };
    };
  }

  return {
    host,
    workspace,
    home,
    messages,
    lockEvents,
    llmCalls,
    subAgentCalls,
    fireInput: (raw: string) => inputCb?.(raw),
    fireBefore: (msg: string) => beforeCb?.(msg),
    fireCompaction: (event: CompactionEvent) => compactionCb?.(event),
    hasCompactionListener: () => compactionCb !== null,
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

  it("inherits host mode and custom instructions into the sub-agent prompt", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      mode: "plan",
      systemPromptOptions: {
        systemPrompt: "HOST-BASE-PROMPT-MUST-NOT-LEAK",
        customInstructions: "Always answer in German.",
      },
    });
    try {
      writeSkill(h.workspace, "demo", "Do the demo.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const prompt = h.subAgentCalls[0]!.systemPrompt;
      assert.match(prompt, /^Do the demo\./, "skill instructions stay first");
      assert.match(prompt, /Host mode: plan/);
      assert.match(prompt, /Always answer in German\./);
      // The auggie directive keeps its emphasis as the final block.
      assert.match(prompt, /codebase-retrieval[\s\S]*$/);
      assert.ok(
        prompt.indexOf("Host mode") < prompt.indexOf("codebase-retrieval"),
        "host context comes before the auggie directive"
      );
      // The host's base prompt is inspection-only and never inlined.
      assert.ok(!prompt.includes("HOST-BASE-PROMPT-MUST-NOT-LEAK"));
    } finally {
      h.cleanup();
    }
  });

  it("builds the legacy prompt on hosts without the 0.78.1 helpers", async () => {
    const h = harness({ llmResponses: [...PASSING_LLM_PAIR] });
    try {
      writeSkill(h.workspace, "demo", "Do the demo.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const prompt = h.subAgentCalls[0]!.systemPrompt;
      assert.ok(!prompt.includes("Host mode"));
      assert.ok(!prompt.includes("Host custom instructions"));
      assert.match(prompt, /codebase-retrieval/);
    } finally {
      h.cleanup();
    }
  });

  it("omits blank mode/instructions and truncates oversized instructions", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR],
      mode: "   ",
      systemPromptOptions: { customInstructions: "x".repeat(5_000) },
    });
    try {
      writeSkill(h.workspace, "demo", "Do the demo.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      const prompt = h.subAgentCalls[0]!.systemPrompt;
      assert.ok(!prompt.includes("Host mode"), "blank mode is omitted");
      assert.match(prompt, /\[\.\.\.truncated\]/);
      assert.ok(prompt.length < 5_000, "instructions are bounded");
    } finally {
      h.cleanup();
    }
  });

  it("retries a transiently failing routing call and still executes the skill", async () => {
    // Call #0 (first Actor attempt) rejects; the retry (call #1) and the
    // Judge call (call #2) succeed.
    const h = harness({
      llmResponses: ["", ...PASSING_LLM_PAIR],
      llmErrors: [new Error("ECONNRESET")],
      settingsOverride: { routingRetryBaseDelayMs: 5 },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.llmCalls.length, 3, "expected 1 failed + 2 successful calls");
      assert.equal(h.subAgentCalls.length, 1);
      const assistant = h.messages.find((m) => m.kind === "assistant");
      assert.equal(assistant?.text, "DONE");
    } finally {
      h.cleanup();
    }
  });

  it("gives up after exhausting routing retries and aborts the skill", async () => {
    const boom = new Error("upstream 503");
    const h = harness({
      llmResponses: [],
      llmErrors: [boom, boom, boom],
      settingsOverride: { routingMaxRetries: 2, routingRetryBaseDelayMs: 5 },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      assert.equal(h.llmCalls.length, 3, "expected exactly maxRetries+1 attempts");
      assert.equal(h.subAgentCalls.length, 0);
      const sys = h.messages.find((m) => m.text.includes("upstream 503"));
      assert.ok(sys, "expected the final error surfaced as a system message");
    } finally {
      h.cleanup();
    }
  });

  it("routingMaxRetries: 0 disables retries entirely", async () => {
    const h = harness({
      llmResponses: [],
      llmErrors: [new Error("boom")],
      settingsOverride: { routingMaxRetries: 0 },
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");
      assert.equal(h.llmCalls.length, 1);
      assert.equal(h.subAgentCalls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it("does not retry routing timeouts — they fall through to the Q&A path", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR, ...PASSING_LLM_PAIR],
      settingsOverride: {
        routingTimeoutMs: 25,
        qaTimeoutMs: 25,
        routingRetryBaseDelayMs: 5,
      },
      llmDelayMs: 200,
    });
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });
      await router.trigger("/skill:demo");

      // 2 iterations x (Actor + Judge) = 4 calls; retries would inflate this.
      assert.equal(h.llmCalls.length, 4);
      const ask = h.messages.find((m) => m.text.includes("Missing context for skill"));
      assert.ok(ask, "expected the timeout to degrade into Q&A, not retries");
    } finally {
      h.cleanup();
    }
  });

  it("lowers the overflow ceiling on retry-bound compactions and resets per run", async () => {
    const h = harness({
      llmResponses: [...PASSING_LLM_PAIR, ...PASSING_LLM_PAIR],
      withCompaction: true,
    });
    const auggieCtx = {
      serverName: "auggie",
      toolName: "codebase-retrieval",
      args: {},
    };
    const payload = "x".repeat(13_000); // between floor (5 000) and ceiling (25 000)
    try {
      writeSkill(h.workspace, "demo", "Do it.");
      const router = createRouter(h.host, { preflight: h.preflight });

      await router.trigger("/skill:demo");
      const mw1 = h.subAgentCalls[0]!.toolResultMiddleware!;
      assert.deepEqual(mw1(auggieCtx, payload), { block: false });

      // Overflow compaction with retry: 25 000 → 12 500. The middleware
      // reads the live ceiling, so the already-captured mw1 now blocks.
      h.fireCompaction({ reason: "overflow", willRetry: true });
      assert.equal(mw1(auggieCtx, payload).block, true);

      // Manual and non-retry compactions never shrink the ceiling further.
      h.fireCompaction({ reason: "manual", willRetry: true });
      h.fireCompaction({ reason: "threshold", willRetry: false });
      assert.equal(mw1(auggieCtx, "x".repeat(12_000)).block, false);

      // A fresh skill run starts back at the configured ceiling.
      await router.trigger("/skill:demo");
      const mw2 = h.subAgentCalls[1]!.toolResultMiddleware!;
      assert.deepEqual(mw2(auggieCtx, payload), { block: false });
    } finally {
      h.cleanup();
    }
  });

  it("dispose() unsubscribes the compaction listener", async () => {
    const h = harness({ llmResponses: [], withCompaction: true });
    try {
      const router = createRouter(h.host, { preflight: h.preflight });
      assert.equal(h.hasCompactionListener(), true);
      router.dispose();
      assert.equal(h.hasCompactionListener(), false);
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
});
