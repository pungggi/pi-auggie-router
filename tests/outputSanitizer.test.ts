import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeFinalText } from "../src/outputSanitizer.ts";
import type { OutputSanitizerSettings } from "../src/types.ts";

const DEFAULTS: OutputSanitizerSettings = {
  enabled: true,
  finalOutputMaxChars: 120_000,
  stripToolTraces: true,
};

describe("sanitizeFinalText", () => {
  it("is a no-op when disabled", () => {
    const input = "```tool_result\nLEAK\n```\nhello";
    const r = sanitizeFinalText(input, { ...DEFAULTS, enabled: false });
    assert.equal(r.text, input);
    assert.equal(r.removedSections, 0);
    assert.equal(r.truncated, false);
  });

  it("leaves a clean markdown answer unchanged", () => {
    const md =
      "# Heading\n\nSome prose.\n\n```ts\nconst x = 1;\n```\n\nDone.";
    const r = sanitizeFinalText(md, DEFAULTS);
    assert.equal(r.text, md);
    assert.equal(r.removedSections, 0);
    assert.equal(r.truncated, false);
  });

  it("strips a fenced `tool_result` block", () => {
    const input =
      "Answer:\n\n```tool_result\n{\"big\":\"blob\"}\n```\n\nFinal text.";
    const r = sanitizeFinalText(input, DEFAULTS);
    assert.ok(!r.text.includes("big"));
    assert.ok(r.text.includes("Final text."));
    assert.equal(r.removedSections, 1);
  });

  it("strips a fenced `tool_use` and `codebase-retrieval` block", () => {
    const input =
      "Pre\n```tool_use\nABC\n```\nMid\n```codebase-retrieval\nDEF\n```\nPost";
    const r = sanitizeFinalText(input, DEFAULTS);
    assert.ok(!r.text.includes("ABC"));
    assert.ok(!r.text.includes("DEF"));
    assert.ok(r.text.includes("Pre"));
    assert.ok(r.text.includes("Mid"));
    assert.ok(r.text.includes("Post"));
    assert.equal(r.removedSections, 2);
  });

  it("preserves legitimate ts/js/json/py fences", () => {
    const input =
      "```ts\nconst a = 1;\n```\n```json\n{\"k\":1}\n```\n```py\nx = 1\n```";
    const r = sanitizeFinalText(input, DEFAULTS);
    assert.ok(r.text.includes("const a = 1"));
    assert.ok(r.text.includes('"k":1'));
    assert.ok(r.text.includes("x = 1"));
    assert.equal(r.removedSections, 0);
  });

  it("strips bare MCP envelope JSON lines", () => {
    const input =
      'Answer first.\n{"jsonrpc":"2.0","id":1,"result":{"x":1}}\nThen more.';
    const r = sanitizeFinalText(input, DEFAULTS);
    assert.ok(!r.text.includes("jsonrpc"));
    assert.ok(r.text.includes("Answer first"));
    assert.ok(r.text.includes("Then more"));
    assert.equal(r.removedSections, 1);
  });

  it("truncates above finalOutputMaxChars with marker, honoring cap strictly", () => {
    const big = "x".repeat(2000);
    const cap = 500;
    const r = sanitizeFinalText(big, { ...DEFAULTS, finalOutputMaxChars: cap });
    assert.equal(r.truncated, true);
    assert.match(r.text, /truncated by output sanitizer at 500 chars/);
    // Final length must not exceed cap — marker counts against budget.
    assert.ok(
      r.text.length <= cap,
      `final length ${r.text.length} exceeded cap ${cap}`
    );
    assert.ok(r.finalChars <= cap);
    // Body must still start with the actual content prefix.
    assert.ok(r.text.startsWith("x"));
  });

  it("does not truncate when finalOutputMaxChars is 0", () => {
    const big = "y".repeat(2000);
    const r = sanitizeFinalText(big, { ...DEFAULTS, finalOutputMaxChars: 0 });
    assert.equal(r.truncated, false);
    assert.equal(r.text.length, 2000);
  });

  it("respects stripToolTraces=false", () => {
    const input = "```tool_result\nKEEP_ME\n```";
    const r = sanitizeFinalText(input, {
      ...DEFAULTS,
      stripToolTraces: false,
    });
    assert.ok(r.text.includes("KEEP_ME"));
    assert.equal(r.removedSections, 0);
  });

  it("reports accurate char counts", () => {
    const input = "abcd";
    const r = sanitizeFinalText(input, DEFAULTS);
    assert.equal(r.originalChars, 4);
    assert.equal(r.finalChars, 4);
  });
});
