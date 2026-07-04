import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../src/index.ts";
import { makeSkillAutocomplete, suggestSkills, SKILL_TRIGGER } from "../src/autocomplete.ts";
import { listSkills } from "../src/parser.ts";
import type { AutocompleteSpec, PiHost } from "../src/types.ts";

function makeHost(overrides: Partial<PiHost> = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "pi-ac-ws-"));
  const home = mkdtempSync(join(tmpdir(), "pi-ac-home-"));
  const host: PiHost = {
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
    ...overrides,
  };
  return {
    host,
    workspace,
    home,
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function writeSkill(root: string, relDir: string, name: string, body: string): void {
  const dir = join(root, relDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

describe("listSkills", () => {
  it("returns skills from workspace and home, sorted by name", () => {
    const h = makeHost();
    try {
      writeSkill(h.workspace, ".pi/skills", "zeta", "Do z.");
      writeSkill(h.home, ".pi/agent/skills", "alpha", "Do a.");
      const skills = listSkills(h.host);
      assert.deepEqual(
        skills.map((s) => [s.name, s.source]),
        [
          ["alpha", "home"],
          ["zeta", "workspace"],
        ]
      );
    } finally {
      h.cleanup();
    }
  });

  it("workspace skills shadow home skills of the same name", () => {
    const h = makeHost();
    try {
      writeSkill(h.workspace, ".pi/skills", "demo", "workspace version");
      writeSkill(h.home, ".pi/agent/skills", "demo", "home version");
      const skills = listSkills(h.host);
      assert.equal(skills.length, 1);
      assert.equal(skills[0]!.source, "workspace");
    } finally {
      h.cleanup();
    }
  });

  it("extracts frontmatter description and survives malformed frontmatter", () => {
    const h = makeHost();
    try {
      writeSkill(
        h.workspace,
        ".pi/skills",
        "described",
        "---\ndescription: Runs the demo\n---\nBody."
      );
      writeSkill(h.workspace, ".pi/skills", "broken", "---\n: not yaml [\n---\nBody.");
      const skills = listSkills(h.host);
      const described = skills.find((s) => s.name === "described");
      assert.equal(described?.description, "Runs the demo");
      // Malformed frontmatter still lists the skill, just without description.
      const broken = skills.find((s) => s.name === "broken");
      assert.ok(broken);
      assert.equal(broken!.description, undefined);
    } finally {
      h.cleanup();
    }
  });

  it("skips entries with invalid names or without SKILL.md", () => {
    const h = makeHost();
    try {
      writeSkill(h.workspace, ".pi/skills", "valid", "Do it.");
      mkdirSync(join(h.workspace, ".pi", "skills", "no-skill-md"), { recursive: true });
      mkdirSync(join(h.workspace, ".pi", "skills", "bad name!"), { recursive: true });
      writeFileSync(join(h.workspace, ".pi", "skills", "bad name!", "SKILL.md"), "x");
      const skills = listSkills(h.host);
      assert.deepEqual(
        skills.map((s) => s.name),
        ["valid"]
      );
    } finally {
      h.cleanup();
    }
  });

  it("returns empty when neither skill root exists", () => {
    const h = makeHost();
    try {
      assert.deepEqual(listSkills(h.host), []);
    } finally {
      h.cleanup();
    }
  });
});

describe("suggestSkills", () => {
  it("suggests all skills right after the trigger and filters by prefix", () => {
    const h = makeHost();
    try {
      writeSkill(h.workspace, ".pi/skills", "demo", "Do it.");
      writeSkill(h.workspace, ".pi/skills", "deploy", "Ship it.");
      writeSkill(h.workspace, ".pi/skills", "review", "Review it.");

      const all = suggestSkills(h.host, "/skill:");
      assert.deepEqual(
        all.map((s) => s.label),
        ["demo", "deploy", "review"]
      );

      const filtered = suggestSkills(h.host, "/skill:de");
      assert.deepEqual(
        filtered.map((s) => s.label),
        ["demo", "deploy"]
      );
      assert.equal(filtered[0]!.value, "/skill:demo ");
    } finally {
      h.cleanup();
    }
  });

  it("stops suggesting once the skill name is complete (space typed)", () => {
    const h = makeHost();
    try {
      writeSkill(h.workspace, ".pi/skills", "demo", "Do it.");
      assert.deepEqual(suggestSkills(h.host, "/skill:demo do something"), []);
    } finally {
      h.cleanup();
    }
  });

  it("ignores input that doesn't start with the trigger", () => {
    const h = makeHost();
    try {
      writeSkill(h.workspace, ".pi/skills", "demo", "Do it.");
      assert.deepEqual(suggestSkills(h.host, "hello world"), []);
    } finally {
      h.cleanup();
    }
  });
});

describe("createRouter autocomplete wiring", () => {
  it("registers the /skill: trigger on hosts that support it and unregisters on dispose", () => {
    let registered: AutocompleteSpec | null = null;
    let unregistered = false;
    const h = makeHost({
      registerAutocomplete: (spec) => {
        registered = spec;
        return () => {
          unregistered = true;
        };
      },
    });
    try {
      writeSkill(h.workspace, ".pi/skills", "demo", "Do it.");
      const router = createRouter(h.host, {
        preflight: async () => ({ ok: true, detail: "" }),
      });

      assert.ok(registered, "expected registerAutocomplete to be called");
      assert.equal(registered!.trigger, SKILL_TRIGGER);
      assert.deepEqual(
        registered!.getSuggestions("/skill:").map((s) => s.label),
        ["demo"]
      );

      router.dispose();
      assert.ok(unregistered, "expected dispose to unregister autocomplete");
    } finally {
      h.cleanup();
    }
  });

  it("works unchanged on hosts without registerAutocomplete", () => {
    const h = makeHost();
    try {
      const router = createRouter(h.host, {
        preflight: async () => ({ ok: true, detail: "" }),
      });
      router.dispose();
    } finally {
      h.cleanup();
    }
  });

  it("makeSkillAutocomplete exposes the trigger constant", () => {
    const h = makeHost();
    try {
      assert.equal(makeSkillAutocomplete(h.host).trigger, SKILL_TRIGGER);
    } finally {
      h.cleanup();
    }
  });
});
