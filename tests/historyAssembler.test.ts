import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assembleHistory } from "../src/historyAssembler.ts";
import { DEFAULT_HISTORY_ASSEMBLY } from "../src/config.ts";
import type { ChatMessage, HistoryAssemblySettings } from "../src/types.ts";

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

const SETTINGS_RECENT: HistoryAssemblySettings = { ...DEFAULT_HISTORY_ASSEMBLY };

const SETTINGS_HEADTAIL: HistoryAssemblySettings = {
  strategy: "headTail",
  headMessages: 2,
  tailMessages: 3,
  middleMode: "marker",
  maxCharsPerMessage: 0,
  maxTotalChars: 0,
};

describe("assembleHistory", () => {
  it("returns empty array for empty history", () => {
    assert.deepEqual(assembleHistory([], SETTINGS_RECENT), []);
    assert.deepEqual(assembleHistory([], SETTINGS_HEADTAIL), []);
  });

  it("passes recent strategy through unchanged with no caps", () => {
    const hist = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    const out = assembleHistory(hist, {
      ...SETTINGS_RECENT,
      maxCharsPerMessage: 0,
      maxTotalChars: 0,
    });
    assert.deepEqual(out, hist);
  });

  it("keeps short history intact when head+tail >= length", () => {
    const hist = [
      msg("user", "1"),
      msg("user", "2"),
      msg("user", "3"),
      msg("user", "4"),
    ];
    const out = assembleHistory(hist, SETTINGS_HEADTAIL);
    assert.deepEqual(out, hist);
  });

  it("inserts middle-omitted marker when headTail truncates", () => {
    const hist: ChatMessage[] = [];
    for (let i = 1; i <= 10; i++) hist.push(msg("user", `msg-${i}-xxxxx`));
    const out = assembleHistory(hist, SETTINGS_HEADTAIL);
    // 2 head + 1 marker + 3 tail
    assert.equal(out.length, 6);
    assert.equal(out[0]!.content, "msg-1-xxxxx");
    assert.equal(out[1]!.content, "msg-2-xxxxx");
    assert.equal(out[2]!.role, "system");
    assert.match(out[2]!.content, /history-omitted-middle: 5 message\(s\)/);
    assert.match(out[2]!.content, /~\d+ chars/);
    assert.equal(out[3]!.content, "msg-8-xxxxx");
    assert.equal(out[4]!.content, "msg-9-xxxxx");
    assert.equal(out[5]!.content, "msg-10-xxxxx");
  });

  it("omits middle silently when middleMode is omit", () => {
    const hist: ChatMessage[] = [];
    for (let i = 1; i <= 10; i++) hist.push(msg("user", `m${i}`));
    const out = assembleHistory(hist, {
      ...SETTINGS_HEADTAIL,
      middleMode: "omit",
    });
    // 2 head + 3 tail, no marker
    assert.equal(out.length, 5);
    for (const m of out) {
      assert.notEqual(m.role, "system");
    }
  });

  it("enforces per-message char cap with truncation marker", () => {
    const hist = [msg("user", "x".repeat(50)), msg("user", "y")];
    const out = assembleHistory(hist, {
      ...SETTINGS_RECENT,
      maxCharsPerMessage: 20,
      maxTotalChars: 0,
    });
    assert.equal(out.length, 2);
    assert.ok(out[0]!.content.startsWith("x".repeat(20)));
    assert.ok(out[0]!.content.includes("[...truncated]"));
    assert.equal(out[1]!.content, "y");
  });

  it("enforces total char cap by dropping middle entries", () => {
    const hist: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) hist.push(msg("user", "z".repeat(100)));
    const out = assembleHistory(hist, {
      ...SETTINGS_RECENT,
      maxCharsPerMessage: 0,
      maxTotalChars: 350,
    });
    // Sum should be at most 350
    const total = out.reduce((s, m) => s + m.content.length, 0);
    assert.ok(total <= 350, `total=${total}`);
    // First and last should be preserved (or trimmed last)
    assert.ok(out.length >= 2);
  });

  it("does not duplicate when head + tail exactly cover history", () => {
    const hist = [
      msg("user", "1"),
      msg("user", "2"),
      msg("user", "3"),
      msg("user", "4"),
      msg("user", "5"),
    ];
    const out = assembleHistory(hist, SETTINGS_HEADTAIL); // head=2, tail=3
    assert.deepEqual(out.map((m) => m.content), ["1", "2", "3", "4", "5"]);
  });

  it("legacy `recent` is the default strategy", () => {
    assert.equal(DEFAULT_HISTORY_ASSEMBLY.strategy, "recent");
  });

  it("total-cap eviction drops the omitted-middle marker before real content", () => {
    // 12 messages; head=2, tail=3 → output is [h1, h2, marker, t1, t2, t3].
    // Total cap forces eviction; the marker should go before any t*.
    const hist: ChatMessage[] = [];
    for (let i = 1; i <= 12; i++) hist.push(msg("user", "x".repeat(20)));
    const out = assembleHistory(hist, {
      ...SETTINGS_HEADTAIL,
      // 5 real messages * 20 chars = 100. Marker text ~50 chars. Cap at 120
      // forces the marker to be dropped (it's the cheapest to lose) and
      // leaves all 5 real messages intact.
      maxCharsPerMessage: 0,
      maxTotalChars: 120,
    });
    assert.equal(out.length, 5, "marker dropped, 5 real msgs preserved");
    for (const m of out) {
      assert.notEqual(m.role, "system", "no marker should remain");
    }
  });

  it("total-cap eviction preserves first and last anchors", () => {
    const hist: ChatMessage[] = [
      msg("user", "FIRST"),
      msg("user", "x".repeat(100)),
      msg("user", "y".repeat(100)),
      msg("user", "z".repeat(100)),
      msg("user", "LAST"),
    ];
    const out = assembleHistory(hist, {
      ...SETTINGS_RECENT,
      maxCharsPerMessage: 0,
      maxTotalChars: 50,
    });
    assert.ok(out.length >= 1);
    assert.equal(out[0]!.content, "FIRST", "first anchor preserved");
    // Last anchor either preserved verbatim or truncated in place.
    assert.ok(
      out[out.length - 1]!.content.startsWith("LAST") ||
        out[out.length - 1]!.content.includes("[...truncated]")
    );
    const total = out.reduce((s, m) => s + m.content.length, 0);
    assert.ok(total <= 50, `total=${total}`);
  });
});
