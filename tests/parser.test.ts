import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchSkillCommand,
  matchLocalSkillCommand,
  parseSkillFile,
  locateSkillFile,
  isLocalExecution,
  SkillNotFoundError,
  InvalidSkillNameError,
} from "../src/parser.ts";
import type { ParsedSkill, PiHost } from "../src/types.ts";

describe("matchSkillCommand", () => {
  it("matches /skill:name with no remainder", () => {
    const m = matchSkillCommand("/skill:refactor");
    assert.deepEqual(m, { name: "refactor", remainder: "" });
  });

  it("captures trailing prose as remainder", () => {
    const m = matchSkillCommand("/skill:plan-feature build the new button");
    assert.deepEqual(m, { name: "plan-feature", remainder: "build the new button" });
  });

  it("rejects non-skill commands", () => {
    assert.equal(matchSkillCommand("/help"), null);
    assert.equal(matchSkillCommand("hello /skill:x"), null);
    assert.equal(matchSkillCommand(""), null);
  });

  it("tolerates leading whitespace", () => {
    const m = matchSkillCommand("   /skill:abc");
    assert.deepEqual(m, { name: "abc", remainder: "" });
  });

  it("does not match the local escape-hatch prefixes", () => {
    // `/skill-local:` and `/skill!:` are disjoint from `/skill:`.
    assert.equal(matchSkillCommand("/skill-local:foo"), null);
    assert.equal(matchSkillCommand("/skill!:foo"), null);
  });
});

describe("matchLocalSkillCommand", () => {
  it("matches /skill-local:name", () => {
    assert.deepEqual(matchLocalSkillCommand("/skill-local:foo"), {
      name: "foo",
      remainder: "",
    });
  });

  it("matches /skill!:name", () => {
    assert.deepEqual(matchLocalSkillCommand("/skill!:foo"), {
      name: "foo",
      remainder: "",
    });
  });

  it("captures trailing prose as remainder", () => {
    assert.deepEqual(matchLocalSkillCommand("/skill-local:foo do the thing"), {
      name: "foo",
      remainder: "do the thing",
    });
  });

  it("tolerates leading whitespace", () => {
    assert.deepEqual(matchLocalSkillCommand("   /skill!:abc"), {
      name: "abc",
      remainder: "",
    });
  });

  it("rejects the standard /skill: form", () => {
    assert.equal(matchLocalSkillCommand("/skill:foo"), null);
  });

  it("rejects unrelated input", () => {
    assert.equal(matchLocalSkillCommand("/help"), null);
    assert.equal(matchLocalSkillCommand("hello"), null);
    assert.equal(matchLocalSkillCommand(""), null);
  });
});

describe("parseSkillFile", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-skill-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts the model frontmatter and trims body", () => {
    const file = join(dir, "SKILL.md");
    writeFileSync(
      file,
      `---\nmodel: claude-3-7-sonnet\nallowed-tools: ignored\n---\n\nDo the thing.\n`
    );
    const parsed = parseSkillFile("doer", file);
    assert.equal(parsed.name, "doer");
    assert.equal(parsed.rawModel, "claude-3-7-sonnet");
    assert.equal(parsed.instructions, "Do the thing.");
  });

  it("returns undefined for missing model frontmatter", () => {
    const file = join(dir, "SKILL2.md");
    writeFileSync(file, "Just instructions, no frontmatter.");
    const parsed = parseSkillFile("plain", file);
    assert.equal(parsed.rawModel, undefined);
    assert.equal(parsed.instructions, "Just instructions, no frontmatter.");
  });

  it("parses execution-mode frontmatter signals", () => {
    const file = join(dir, "SKILL_EXEC.md");
    writeFileSync(
      file,
      `---\nname: hitl-thing\ndisable-model-invocation: true\nrouter: false\nexecution: in-context\n---\nBody.\n`
    );
    const parsed = parseSkillFile("hitl-thing", file);
    assert.equal(parsed.disableModelInvocation, true);
    assert.equal(parsed.router, false);
    assert.equal(parsed.execution, "in-context");
  });
});

describe("isLocalExecution", () => {
  function skill(over: Partial<ParsedSkill> = {}): ParsedSkill {
    return {
      name: "x",
      filePath: "/x",
      rawModel: undefined,
      instructions: "",
      execution: undefined,
      router: undefined,
      disableModelInvocation: undefined,
      ...over,
    };
  }

  it("defaults to routed when no opt-out is present", () => {
    assert.equal(isLocalExecution(skill()), false);
  });

  it("execution: in-context → local", () => {
    assert.equal(isLocalExecution(skill({ execution: "in-context" })), true);
  });

  it("execution: subagent → routed, overriding disable-model-invocation", () => {
    assert.equal(
      isLocalExecution(skill({ execution: "subagent", disableModelInvocation: true })),
      false
    );
  });

  it("router: false → local", () => {
    assert.equal(isLocalExecution(skill({ router: false })), true);
  });

  it("router: true → routed", () => {
    assert.equal(isLocalExecution(skill({ router: true })), false);
  });

  it("disable-model-invocation: true → local", () => {
    assert.equal(isLocalExecution(skill({ disableModelInvocation: true })), true);
  });

  it("execution precedence beats router and disable-model-invocation", () => {
    // in-context wins even if router: true
    assert.equal(
      isLocalExecution(skill({ execution: "in-context", router: true })),
      true
    );
    // subagent wins even if disable-model-invocation: true
    assert.equal(
      isLocalExecution(skill({ execution: "subagent", disableModelInvocation: true })),
      false
    );
  });
});

describe("locateSkillFile", () => {
  let workspace: string;
  let home: string;
  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "pi-ws-"));
    home = mkdtempSync(join(tmpdir(), "pi-home-"));
  });
  after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function makeHost(extraRoots?: string[]): PiHost {
    return {
      postSystemMessage: () => {},
      postAssistantMessage: () => {},
      setInputLocked: () => {},
      getRecentMessages: () => [],
      callLLM: async () => ({ text: "" }),
      runSubAgent: async () => ({ finalText: "", stoppedReason: "completed" }),
      onBeforeMessage: () => () => {},
      onUserInput: () => () => {},
      resolveWorkspacePath: (rel) => join(workspace, rel),
      resolveHomePath: (rel) => join(home, rel),
      ...(extraRoots ? { listSkillRoots: () => extraRoots } : {}),
    };
  }

  it("prefers workspace skill over user skill", () => {
    mkdirSync(join(workspace, ".pi", "skills", "shared"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "skills", "shared", "SKILL.md"), "ws");
    mkdirSync(join(home, ".pi", "agent", "skills", "shared"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "skills", "shared", "SKILL.md"), "home");
    const found = locateSkillFile(makeHost(), "shared");
    assert.ok(found.startsWith(workspace));
  });

  it("falls back to home skills dir", () => {
    mkdirSync(join(home, ".pi", "agent", "skills", "lonely"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "skills", "lonely", "SKILL.md"), "home");
    const found = locateSkillFile(makeHost(), "lonely");
    assert.ok(found.startsWith(home));
  });

  it("throws SkillNotFoundError when nothing exists", () => {
    assert.throws(() => locateSkillFile(makeHost(), "ghost"), SkillNotFoundError);
  });

  it("searches host.listSkillRoots() after the two hard-coded dirs", () => {
    const extraRoot = mkdtempSync(join(tmpdir(), "pi-extra-"));
    try {
      // Plant the skill ONLY under the extra root (not in workspace/home).
      mkdirSync(join(extraRoot, "claudey"), { recursive: true });
      writeFileSync(join(extraRoot, "claudey", "SKILL.md"), "extra");
      const found = locateSkillFile(makeHost([extraRoot]), "claudey");
      assert.ok(found.startsWith(extraRoot));
    } finally {
      rmSync(extraRoot, { recursive: true, force: true });
    }
  });

  it("prefers workspace skill over host.listSkillRoots() entries", () => {
    const extraRoot = mkdtempSync(join(tmpdir(), "pi-extra2-"));
    try {
      mkdirSync(join(workspace, ".pi", "skills", "shared2"), { recursive: true });
      writeFileSync(join(workspace, ".pi", "skills", "shared2", "SKILL.md"), "ws");
      mkdirSync(join(extraRoot, "shared2"), { recursive: true });
      writeFileSync(join(extraRoot, "shared2", "SKILL.md"), "extra");
      const found = locateSkillFile(makeHost([extraRoot]), "shared2");
      assert.ok(found.startsWith(workspace));
    } finally {
      rmSync(extraRoot, { recursive: true, force: true });
    }
  });

  it("rejects skill names with path separators (M1 traversal guard)", () => {
    // Plant a real file at the traversal target so a buggy implementation
    // would happily read it.
    mkdirSync(join(workspace, "leak"), { recursive: true });
    writeFileSync(join(workspace, "leak", "SKILL.md"), "leaked");
    const traversal = join("..", "..", "leak");
    assert.throws(
      () => locateSkillFile(makeHost(), traversal),
      InvalidSkillNameError
    );
  });

  it("rejects skill names containing dots, slashes, or backslashes", () => {
    for (const bad of ["..", "a/b", "a\\b", "a.b", "a b", ""]) {
      assert.throws(
        () => locateSkillFile(makeHost(), bad),
        InvalidSkillNameError,
        `expected ${JSON.stringify(bad)} to be rejected`
      );
    }
  });
});
