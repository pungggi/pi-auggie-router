/**
 * Deterministic fake `PiHost` for long-session regression fixtures.
 *
 * Does NOT make real LLM calls. Each fixture provides a queue of canned
 * Actor/Judge JSON responses. `runSubAgent` is unimplemented by default —
 * fixtures here only exercise the routing/history layer.
 */

import type {
  ChatMessage,
  LLMCallOptions,
  LLMResponse,
  PiHost,
} from "../../src/types.ts";

export interface FakeHostOptions {
  history: ChatMessage[];
  /** Canned responses returned in order from `callLLM`. */
  llmResponses: string[];
}

export interface FakeHost {
  host: PiHost;
  llmCalls: LLMCallOptions[];
  systemMessages: string[];
  assistantMessages: string[];
  logs: { level: string; msg: string }[];
}

export function createFakeHost(opts: FakeHostOptions): FakeHost {
  const llmCalls: LLMCallOptions[] = [];
  const systemMessages: string[] = [];
  const assistantMessages: string[] = [];
  const logs: { level: string; msg: string }[] = [];
  let cursor = 0;

  const host: PiHost = {
    postSystemMessage: (text) => systemMessages.push(text),
    postAssistantMessage: (text) => assistantMessages.push(text),
    setInputLocked: () => {},
    getRecentMessages: (n) => opts.history.slice(-n),
    callLLM: async (o: LLMCallOptions): Promise<LLMResponse> => {
      llmCalls.push(o);
      const text = opts.llmResponses[cursor] ?? "";
      cursor += 1;
      return { text };
    },
    runSubAgent: async () => {
      throw new Error("FakeHost: runSubAgent should not be invoked in this suite");
    },
    onBeforeMessage: () => () => {},
    onUserInput: () => () => {},
    resolveWorkspacePath: (rel) => rel,
    resolveHomePath: (rel) => rel,
    log: (level, msg) => logs.push({ level, msg }),
  };

  return { host, llmCalls, systemMessages, assistantMessages, logs };
}
