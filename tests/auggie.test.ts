import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveOverflowCeiling,
  AUGGIE_DIRECTIVE,
  AUGGIE_MCP_NAME,
  AUGGIE_TOOL_NAME,
  buildAuggieMcpSpec,
  makeOverflowMiddleware,
} from "../src/auggie.ts";

describe("makeOverflowMiddleware", () => {
  const mw = makeOverflowMiddleware(25_000);

  it("passes through small auggie payloads", () => {
    const res = mw(
      { serverName: AUGGIE_MCP_NAME, toolName: AUGGIE_TOOL_NAME, args: {} },
      "tiny"
    );
    assert.deepEqual(res, { block: false });
  });

  it("blocks oversized auggie codebase-retrieval payloads", () => {
    const big = "x".repeat(25_001);
    const res = mw(
      { serverName: AUGGIE_MCP_NAME, toolName: AUGGIE_TOOL_NAME, args: {} },
      big
    );
    assert.equal(res.block, true);
    if (res.block) {
      assert.match(res.replacement, /refine your codebase-retrieval query/);
    }
  });

  it("ignores non-auggie servers even when oversized", () => {
    const big = "x".repeat(25_001);
    const res = mw(
      { serverName: "other", toolName: AUGGIE_TOOL_NAME, args: {} },
      big
    );
    assert.deepEqual(res, { block: false });
  });

  it("ignores non-codebase-retrieval auggie tools", () => {
    const big = "x".repeat(25_001);
    const res = mw(
      { serverName: AUGGIE_MCP_NAME, toolName: "ping", args: {} },
      big
    );
    assert.deepEqual(res, { block: false });
  });

  it("counts UTF-8 bytes, not characters", () => {
    // `é` is 2 bytes; 12_501 chars = 25_002 bytes, just over the ceiling.
    const big = "é".repeat(12_501);
    const res = mw(
      { serverName: AUGGIE_MCP_NAME, toolName: AUGGIE_TOOL_NAME, args: {} },
      big
    );
    assert.equal(res.block, true);
  });

  it("treats payloads at exactly the ceiling as in-bounds", () => {
    const exact = "x".repeat(25_000);
    const res = mw(
      { serverName: AUGGIE_MCP_NAME, toolName: AUGGIE_TOOL_NAME, args: {} },
      exact
    );
    assert.deepEqual(res, { block: false });
  });

  it("re-reads a getter ceiling on every call", () => {
    let ceiling = 25_000;
    const dyn = makeOverflowMiddleware(() => ceiling);
    const ctx = { serverName: AUGGIE_MCP_NAME, toolName: AUGGIE_TOOL_NAME, args: {} };
    const payload = "x".repeat(13_000);

    assert.deepEqual(dyn(ctx, payload), { block: false });
    ceiling = 12_500;
    assert.equal(dyn(ctx, payload).block, true);
  });
});

describe("AdaptiveOverflowCeiling", () => {
  it("starts at the configured ceiling", () => {
    const c = new AdaptiveOverflowCeiling(25_000, 5_000);
    assert.equal(c.get(), 25_000);
  });

  it("halves per lower() and clamps at the floor", () => {
    const c = new AdaptiveOverflowCeiling(25_000, 5_000);
    assert.equal(c.lower(), 12_500);
    assert.equal(c.lower(), 6_250);
    assert.equal(c.lower(), 5_000);
    // At the floor, lower() is a no-op and signals it with null.
    assert.equal(c.lower(), null);
    assert.equal(c.get(), 5_000);
  });

  it("reset() restores the configured ceiling", () => {
    const c = new AdaptiveOverflowCeiling(25_000, 5_000);
    c.lower();
    c.reset();
    assert.equal(c.get(), 25_000);
  });

  it("never lowers when the floor is at or above the configured ceiling", () => {
    const c = new AdaptiveOverflowCeiling(5_000, 25_000);
    assert.equal(c.lower(), null);
    assert.equal(c.get(), 5_000);
  });
});

describe("buildAuggieMcpSpec", () => {
  it("attaches the auggie MCP via stdio", () => {
    const spec = buildAuggieMcpSpec();
    assert.equal(spec.name, AUGGIE_MCP_NAME);
    assert.equal(spec.command, "auggie");
    assert.deepEqual(spec.args, ["mcp"]);
  });
});

describe("AUGGIE_DIRECTIVE", () => {
  it("instructs the sub-agent to use codebase-retrieval", () => {
    assert.match(AUGGIE_DIRECTIVE, /codebase-retrieval/);
    assert.match(AUGGIE_DIRECTIVE, /Do not attempt to run auggie in the terminal/);
  });
});
