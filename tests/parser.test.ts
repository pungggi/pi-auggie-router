import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchSkillCommand,
  parseSkillFile,
  locateSkillFile,
  SkillNotFoundError,
  InvalidSkillNameError,
} from "../src/parser.ts";
import type { PiHost } from "../src/types.ts";

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

  function makeHost(): PiHost {
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
