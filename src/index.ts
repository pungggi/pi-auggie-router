import { runActorJudgeLoop } from "./actorJudge.js";
import { redactSecrets, runAuggieStatus } from "./auggie.js";
import { DEFAULT_SETTINGS, loadSettings } from "./config.js";
import { mapModel } from "./modelMapper.js";
import {
  InvalidSkillNameError,
  loadSkill,
  matchSkillCommand,
  SkillNotFoundError,
} from "./parser.js";
import { RouterState } from "./state.js";
import { executeSkill } from "./subAgent.js";
import type {
  JudgeRubric,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
} from "./types.js";

export interface RouterHandle {
  /** Detach all hooks. The router is unusable after this. */
  dispose: () => void;
  /** Read the active settings (mostly for tests / debugging). */
  getSettings: () => RouterSettings;
  /** Programmatic skill trigger; mostly for tests. */
  trigger: (raw: string) => Promise<void>;
}

export interface CreateRouterOptions {
  /** Override the auggie pre-flight (used in tests). */
  preflight?: () => Promise<{ ok: boolean; detail: string }>;
}

const LOCK_REASON = "pi-auggie-router: skill execution in progress";

export function createRouter(host: PiHost, opts: CreateRouterOptions = {}): RouterHandle {
  const settings = loadSettings(host);
  const state = new RouterState();
  const preflight = opts.preflight ?? (() => runAuggieStatus(settings));

  const log = (level: "debug" | "info" | "warn" | "error", msg: string) => {
    host.log?.(level, msg);
  };

  async function handleSkillCommand(skillName: string): Promise<void> {
    if (state.isBusy()) {
      host.postSystemMessage(
        `[System]: Router busy (${state.phase}). Wait for the current skill to finish.`
      );
      return;
    }

    let skill: ParsedSkill;
    try {
      skill = loadSkill(host, skillName);
    } catch (err) {
      if (err instanceof SkillNotFoundError || err instanceof InvalidSkillNameError) {
        host.postSystemMessage(`[System]: ${err.message}`);
      } else {
        host.postSystemMessage(
          `[System]: Failed to load skill "${skillName}": ${(err as Error).message}`
        );
      }
      return;
    }

    state.beginEvaluation();
    try {
      const outcome = await runActorJudgeLoop(host, settings, skill);

      let brief: SkillBrief = outcome.brief;
      let rubric: JudgeRubric = outcome.rubric;

      if (!outcome.passed) {
        let answer: string;
        try {
          answer = await waitForUserClarification(skill, brief, rubric);
        } catch (err) {
          // Q&A timed out (or was rejected). Surface a system message and
          // stop without trying to execute. State is already idle because
          // `rejectPending` resets it.
          host.postSystemMessage(
            `[System]: ${(err as Error).message}. Skill /skill:${skill.name} cancelled.`
          );
          return;
        }
        brief = {
          ...brief,
          userClarifications: [...brief.userClarifications, answer],
        };
      }

      const pre = await preflight();
      if (!pre.ok) {
        const detail = redactSecrets(pre.detail.replace(/\s+/g, " ").trim()).slice(0, 200);
        host.postSystemMessage(
          `[System Error]: Cannot execute skill. Augment daemon is offline or unauthenticated.${
            detail ? ` (${detail})` : ""
          }`
        );
        state.reset();
        return;
      }

      state.beginExecution();
      host.setInputLocked(true, LOCK_REASON);
      host.postSystemMessage(
        `[System]: ⚙️ Executing /skill:${skill.name} (Auggie semantic retrieval running...)`
      );

      const resolvedModel = mapModel(skill.rawModel, settings.defaultProvider, settings.allowedProviderPrefixes);
      try {
        const result = await executeSkill(host, settings, {
          skill,
          brief,
          resolvedModel,
        });
        host.postAssistantMessage(result.finalText);
        if (result.stoppedReason !== "completed") {
          host.postSystemMessage(
            `[System]: Sub-agent stopped early (${result.stoppedReason}).`
          );
        }
      } catch (err) {
        host.postSystemMessage(
          `[System]: Sub-agent failed: ${(err as Error).message}`
        );
      } finally {
        host.setInputLocked(false);
        state.reset();
      }
    } catch (err) {
      log("error", `pi-auggie-router: ${(err as Error).message}`);
      host.postSystemMessage(`[System]: ${(err as Error).message}`);
      host.setInputLocked(false);
      state.reset();
    }
  }

  function waitForUserClarification(
    skill: ParsedSkill,
    brief: SkillBrief,
    rubric: JudgeRubric
  ): Promise<string> {
    const question =
      rubric.missingRequirementQuestion ??
      "Could you clarify what this skill should do?";
    host.postSystemMessage(`[System]: Missing context for skill. ${question}`);

    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const wrappedResolve = (a: string) => {
        if (timer) clearTimeout(timer);
        resolve(a);
      };
      const wrappedReject = (e: Error) => {
        if (timer) clearTimeout(timer);
        reject(e);
      };
      state.beginWaitForUser({
        skill,
        brief,
        rubric,
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
      if (settings.qaTimeoutMs > 0) {
        timer = setTimeout(() => {
          state.rejectPending(
            new Error(
              `Q&A timed out after ${Math.round(settings.qaTimeoutMs / 1000)}s waiting for user input`
            )
          );
        }, settings.qaTimeoutMs);
      }
    });
  }

  // --- Hook wiring ---------------------------------------------------------

  // Intercept `/skill:<name>` before Pi's default handler runs.
  const offInput = host.onUserInput((raw) => {
    const match = matchSkillCommand(raw);
    if (!match) return;
    // Fire-and-forget; the state machine + UI lock provide back-pressure.
    void handleSkillCommand(match.name);
    return { cancel: true };
  });

  // While `waitingForUser`, capture the next typed message as the answer.
  // After consumption the state machine flips to `resuming`, so any second
  // message arriving in the same tick falls through as a no-op.
  const offBefore = host.onBeforeMessage((msg) => {
    if (state.phase !== "waitingForUser") return { cancel: false };
    state.consumeUserAnswer(msg);
    return { cancel: true };
  });

  return {
    dispose: () => {
      offInput();
      offBefore();
      state.reset();
    },
    getSettings: () => ({ ...settings }),
    trigger: async (raw: string) => {
      const match = matchSkillCommand(raw);
      if (!match) throw new Error("Not a /skill: command");
      await handleSkillCommand(match.name);
    },
  };
}

export { DEFAULT_SETTINGS };
export { mapModel, DisallowedProviderError } from "./modelMapper.js";
export {
  matchSkillCommand,
  locateSkillFile,
  parseSkillFile,
  loadSkill,
  SkillNotFoundError,
  InvalidSkillNameError,
} from "./parser.js";
export { makeOverflowMiddleware, redactSecrets, runAuggieStatus, AUGGIE_DIRECTIVE, AUGGIE_MCP_NAME, AUGGIE_TOOL_NAME } from "./auggie.js";
export { runActorJudgeLoop } from "./actorJudge.js";
export { RouterState } from "./state.js";
export type {
  ChatMessage,
  JudgeRubric,
  LLMCallOptions,
  LLMResponse,
  MCPServerSpec,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
  SubAgentResult,
  SubAgentRunOptions,
  ToolCallContext,
  ToolResultMiddleware,
  UIInputInterceptor,
} from "./types.js";
