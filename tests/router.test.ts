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
          o.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
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
  };

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
