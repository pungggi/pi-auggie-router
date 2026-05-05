import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeMiddleware } from "../src/auggie.ts";
import type { ToolResultMiddleware } from "../src/types.js";

describe("composeMiddleware", () => {
  it("returns block: false when all middleware pass", () => {
    const mw = composeMiddleware(
      () => ({ block: false as const }),
      () => ({ block: false as const }),
    );
    const result = mw({ serverName: "a", toolName: "b", args: {} }, "result");
    assert.deepStrictEqual(result, { block: false });
  });

  it("short-circuits on first block", () => {
    let secondCalled = false;
    const mw = composeMiddleware(
      () => ({ block: true as const, replacement: "blocked by first" }),
      () => { secondCalled = true; return { block: false as const }; },
    );
    const result = mw({ serverName: "a", toolName: "b", args: {} }, "result");
    assert.strictEqual(result.block, true);
    if (result.block) {
      assert.strictEqual(result.replacement, "blocked by first");
    }
    assert.strictEqual(secondCalled, false, "second middleware should not be called");
  });

  it("short-circuits on second block when first passes", () => {
    let thirdCalled = false;
    const mw = composeMiddleware(
      () => ({ block: false as const }),
      () => ({ block: true as const, replacement: "blocked by second" }),
      () => { thirdCalled = true; return { block: false as const }; },
    );
    const result = mw({ serverName: "a", toolName: "b", args: {} }, "result");
    assert.strictEqual(result.block, true);
    if (result.block) {
      assert.strictEqual(result.replacement, "blocked by second");
    }
    assert.strictEqual(thirdCalled, false);
  });

  it("returns block: false with empty middleware list", () => {
    const mw = composeMiddleware();
    const result = mw({ serverName: "a", toolName: "b", args: {} }, "result");
    assert.deepStrictEqual(result, { block: false });
  });

  it("passes context and rawResult to each middleware", () => {
    let receivedCtx: any = null;
    let receivedRaw: string | null = null;
    const mw = composeMiddleware(
      (ctx, raw) => {
        receivedCtx = ctx;
        receivedRaw = raw;
        return { block: false as const };
      },
    );
    const ctx = { serverName: "test", toolName: "tool", args: { a: 1 } };
    mw(ctx, "raw output");
    assert.strictEqual(receivedCtx?.serverName, "test");
    assert.strictEqual(receivedCtx?.toolName, "tool");
    assert.strictEqual(receivedRaw, "raw output");
  });
});
