import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildSubAgentSystemPrompt } from "../src/subAgent.ts";

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("buildSubAgentSystemPrompt — cache stability", () => {
  const baseInstructions = "Skill: do the thing.\nFollow rules X and Y.";

  it("is deterministic for identical inputs", () => {
    const a = buildSubAgentSystemPrompt({ skillInstructions: baseInstructions });
    const b = buildSubAgentSystemPrompt({ skillInstructions: baseInstructions });
    assert.equal(sha(a), sha(b));
  });

  it("ignores undefined vs empty-string appendix (treated identically)", () => {
    const a = buildSubAgentSystemPrompt({ skillInstructions: baseInstructions });
    const b = buildSubAgentSystemPrompt({
      skillInstructions: baseInstructions,
      appendix: "",
    });
    assert.equal(sha(a), sha(b));
  });

  it("changes only when skill instructions change", () => {
    const a = buildSubAgentSystemPrompt({ skillInstructions: baseInstructions });
    const b = buildSubAgentSystemPrompt({
      skillInstructions: baseInstructions + "\nExtra rule.",
    });
    assert.notEqual(sha(a), sha(b));
  });

  it("changes only when appendix changes", () => {
    const a = buildSubAgentSystemPrompt({
      skillInstructions: baseInstructions,
      appendix: "Bounded context: orders",
    });
    const b = buildSubAgentSystemPrompt({
      skillInstructions: baseInstructions,
      appendix: "Bounded context: shipping",
    });
    assert.notEqual(sha(a), sha(b));
  });

  it("includes the AUGGIE_DIRECTIVE", () => {
    const out = buildSubAgentSystemPrompt({ skillInstructions: baseInstructions });
    assert.match(out, /codebase-retrieval/);
  });

  it("places skill instructions before the AUGGIE_DIRECTIVE", () => {
    const out = buildSubAgentSystemPrompt({ skillInstructions: baseInstructions });
    const skillIdx = out.indexOf("Skill: do the thing.");
    const directiveIdx = out.indexOf("codebase-retrieval");
    assert.ok(skillIdx >= 0 && directiveIdx >= 0);
    assert.ok(skillIdx < directiveIdx);
  });

  it("places appendix after the AUGGIE_DIRECTIVE", () => {
    const out = buildSubAgentSystemPrompt({
      skillInstructions: baseInstructions,
      appendix: "DOMAIN-RULE-APPENDIX",
    });
    const directiveIdx = out.indexOf("codebase-retrieval");
    const appendixIdx = out.indexOf("DOMAIN-RULE-APPENDIX");
    assert.ok(directiveIdx >= 0 && appendixIdx >= 0);
    assert.ok(directiveIdx < appendixIdx);
  });

  it("does not embed dynamic-looking tokens (model, tier, brief, route)", () => {
    const out = buildSubAgentSystemPrompt({ skillInstructions: baseInstructions });
    for (const banned of [
      "execution-route",
      "executionRoute",
      "userGoal",
      "tier",
      "openrouter/",
    ]) {
      assert.ok(!out.includes(banned), `unexpected dynamic token: ${banned}`);
    }
  });
});
