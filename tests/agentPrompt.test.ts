import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PROMPT_BLOCK,
  appendAgentPromptBlock,
  installAgentPromptInjection,
  readPackageVersion,
  type BeforeAgentStartEventLike,
  type ExtensionAPI,
} from "../src/agentPrompt.ts";

describe("AGENT_PROMPT_BLOCK", () => {
  it("is a non-empty markdown string", () => {
    assert.ok(typeof AGENT_PROMPT_BLOCK === "string");
    assert.ok(AGENT_PROMPT_BLOCK.length > 500, "block should be substantial");
    assert.ok(AGENT_PROMPT_BLOCK.startsWith("## "), "should start with a markdown heading");
  });

  it("mentions the correct invocation syntax", () => {
    assert.match(AGENT_PROMPT_BLOCK, /\/skill <name>/);
  });

  it("forbids the colon form explicitly", () => {
    assert.match(AGENT_PROMPT_BLOCK, /Never.*\/skill:refactor/);
  });

  it("documents the three bridge limitations", () => {
    assert.match(AGENT_PROMPT_BLOCK, /Input is not locked while a skill runs/);
    assert.match(AGENT_PROMPT_BLOCK, /Q&A clarification fallback is broken/);
    assert.match(AGENT_PROMPT_BLOCK, /Tool traces are stripped/);
  });

  it("instructs the agent not to pre-load files before delegating", () => {
    assert.match(AGENT_PROMPT_BLOCK, /Never.*read the target file into your own context/);
  });
});

describe("appendAgentPromptBlock", () => {
  it("appends the block to an existing prompt with a blank-line separator", () => {
    const result = appendAgentPromptBlock("You are a helpful assistant.");
    assert.ok(result.startsWith("You are a helpful assistant.\n\n## Delegating to skills"));
    assert.ok(result.endsWith(AGENT_PROMPT_BLOCK));
  });

  it("preserves any user content in the original prompt", () => {
    const original = "Base prompt line 1.\nBase prompt line 2.\n";
    const result = appendAgentPromptBlock(original);
    assert.ok(result.startsWith(original));
  });

  it("is idempotent for empty input", () => {
    const result = appendAgentPromptBlock("");
    assert.ok(result.includes("## Delegating to skills"));
  });
});

describe("readPackageVersion", () => {
  it("returns a non-empty string", () => {
    const v = readPackageVersion();
    assert.ok(typeof v === "string");
    assert.ok(v.length > 0);
  });

  it("returns a semver-looking string from the real package.json", () => {
    const v = readPackageVersion();
    assert.match(v, /^\d+\.\d+\.\d+/);
  });
});

describe("installAgentPromptInjection", () => {
  it("registers a before_agent_start listener", () => {
    const events: string[] = [];
    const fakePi: ExtensionAPI = {
      on(event, handler) {
        events.push(event);
        // Smoke-test the handler with a fake event
        const fakeEvent: BeforeAgentStartEventLike = {
          type: "before_agent_start",
          systemPrompt: "BASE",
        };
        const result = handler(fakeEvent);
        if (result instanceof Promise) {
          // We don't await; this is just a smoke check that it doesn't throw
        }
      },
    };
    installAgentPromptInjection(fakePi);
    assert.deepEqual(events, ["before_agent_start"]);
  });

  it("appends the block to the system prompt via the handler", () => {
    let captured: { systemPrompt: string } | void = undefined;
    const fakePi: ExtensionAPI = {
      on(_event, handler) {
        captured = handler({
          type: "before_agent_start",
          systemPrompt: "ORIGINAL",
        }) as { systemPrompt: string };
      },
    };
    installAgentPromptInjection(fakePi);
    assert.ok(captured);
    assert.ok(captured!.systemPrompt.startsWith("ORIGINAL\n\n## Delegating to skills"));
    assert.ok(captured!.systemPrompt.includes(AGENT_PROMPT_BLOCK));
  });

  it("is a no-op when pi.on is missing", () => {
    const logs: { level: string; msg: string }[] = [];
    const fakePi = {} as unknown as ExtensionAPI;
    installAgentPromptInjection(fakePi, (level, msg) => logs.push({ level, msg }));
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, "warn");
    assert.match(logs[0]!.msg, /ExtensionAPI\.on\(\) not available/);
  });

  it("logs an info message on successful install", () => {
    const logs: { level: string; msg: string }[] = [];
    const fakePi: ExtensionAPI = {
      on() {
        /* swallow */
      },
    };
    installAgentPromptInjection(fakePi, (level, msg) => logs.push({ level, msg }));
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, "info");
    assert.match(logs[0]!.msg, /installed system-prompt injection hook/);
    assert.match(logs[0]!.msg, /v\d+\.\d+\.\d+/);
  });

  it("returns undefined from the handler when the event shape is invalid", () => {
    let captured: unknown = "sentinel";
    const fakePi: ExtensionAPI = {
      on(_event, handler) {
        captured = handler({} as BeforeAgentStartEventLike);
      },
    };
    installAgentPromptInjection(fakePi);
    assert.equal(captured, undefined);
  });

  it("registers the handler under the exact 'before_agent_start' event name", () => {
    let registeredEvent: string | undefined;
    const fakePi: ExtensionAPI = {
      on(event) {
        registeredEvent = event;
      },
    };
    installAgentPromptInjection(fakePi);
    assert.equal(registeredEvent, "before_agent_start");
  });

  it("mutates event.systemPrompt in place as well as returning it", () => {
    const event: BeforeAgentStartEventLike = {
      type: "before_agent_start",
      systemPrompt: "ORIGINAL",
    };
    let returned: { systemPrompt: string } | void;
    const fakePi: ExtensionAPI = {
      on(_event, handler) {
        returned = handler(event) as { systemPrompt: string };
      },
    };
    installAgentPromptInjection(fakePi);
    // In-place mutation contract
    assert.ok(event.systemPrompt.startsWith("ORIGINAL\n\n## Delegating to skills"));
    // Return-value contract — both must agree
    assert.ok(returned);
    assert.equal(returned!.systemPrompt, event.systemPrompt);
  });

  it("is idempotent per pi instance — a second call registers no new listener", () => {
    let registrations = 0;
    const fakePi: ExtensionAPI = {
      on() {
        registrations += 1;
      },
    };
    installAgentPromptInjection(fakePi);
    installAgentPromptInjection(fakePi);
    assert.equal(registrations, 1);
  });
});

describe("settings: promptInjection", () => {
  // We verify the wiring through the public config surface, mirroring the
  // pattern used by other config tests in this suite.
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-auggie-prompt-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to enabled when no settings file exists", async () => {
    // Re-import to ensure clean module state for this test
    const { loadSettings } = await import("../src/config.ts");
    const settings = loadSettings({
      resolveWorkspacePath: (rel: string) => join(dir, rel),
      resolveHomePath: (rel: string) => join(dir, rel),
    } as never);
    assert.equal(settings.promptInjection.enabled, true);
  });

  it("respects an explicit false in settings.json", async () => {
    const { loadSettings } = await import("../src/config.ts");
    const settingsPath = join(dir, "explicit-false");
    const workspaceDir = join(settingsPath, ".pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "settings.json"),
      JSON.stringify({ auggieRouter: { promptInjection: { enabled: false } } })
    );
    const settings = loadSettings({
      resolveWorkspacePath: (rel: string) => join(settingsPath, rel),
      resolveHomePath: (rel: string) => join(settingsPath, rel),
    } as never);
    assert.equal(settings.promptInjection.enabled, false);
  });
});
