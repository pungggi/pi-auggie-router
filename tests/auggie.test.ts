import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUGGIE_DIRECTIVE,
  AUGGIE_MCP_NAME,
  AUGGIE_TOOL_NAME,
  appendCapped,
  buildAuggieMcpSpec,
  makeOverflowMiddleware,
  redactSecrets,
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
});

describe("buildAuggieMcpSpec", () => {
  it("attaches the auggie MCP via stdio", () => {
    const spec = buildAuggieMcpSpec({ auggieBinPath: "auggie" });
    assert.equal(spec.name, AUGGIE_MCP_NAME);
    assert.equal(spec.command, "auggie");
    assert.deepEqual(spec.args, ["mcp"]);
  });

  it("uses the configured auggieBinPath", () => {
    const spec = buildAuggieMcpSpec({ auggieBinPath: "/usr/local/bin/auggie" });
    assert.equal(spec.command, "/usr/local/bin/auggie");
  });
});

describe("AUGGIE_DIRECTIVE", () => {
  it("instructs the sub-agent to use codebase-retrieval", () => {
    assert.match(AUGGIE_DIRECTIVE, /codebase-retrieval/);
    assert.match(AUGGIE_DIRECTIVE, /MCP tool/);
  });
});

describe("appendCapped", () => {
  it("keeps only the last max characters", () => {
    assert.equal(appendCapped("abc", "def", 4), "cdef");
  });

  it("accepts Buffer chunks", () => {
    assert.equal(appendCapped("abc", Buffer.from("def"), 5), "bcdef");
  });
});

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    const input = "Error: Bearer eyJhbGciOiJIUzI1NiJ9.abc123";
    const result = redactSecrets(input);
    assert.ok(!result.includes("eyJhbGciOiJIUzI1NiJ9"));
    assert.ok(result.includes("[REDACTED]"));
  });

  it("redacts api-key assignments", () => {
    const result = redactSecrets('api-key=sk-abc1234567890123456789');
    assert.ok(!result.includes("sk-abc1234567890123456789"));
    assert.ok(result.includes("[REDACTED]"));
  });

  it("redacts OpenAI-style keys", () => {
    const result = redactSecrets("key: sk-proj-abc123def456ghi789jkl012mno345");
    assert.ok(!result.includes("sk-proj-"));
    assert.ok(result.includes("[REDACTED]"));
  });

  it("redacts long hex strings", () => {
    const hex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const result = redactSecrets(`token=${hex}`);
    assert.ok(!result.includes(hex));
  });

  it("leaves safe strings untouched", () => {
    const safe = "daemon not running, exit code 1";
    assert.equal(redactSecrets(safe), safe);
  });
});
