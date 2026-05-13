import { runActorJudgeLoop } from "./actorJudge.js";
import { redactSecrets, runAuggieStatus } from "./auggie.js";
import { loadSettings } from "./config.js";
import { chooseContextBudget } from "./contextBudget.js";
import {
  chooseExecutionModel,
  type ExecutionRouteSelection,
} from "./executionRouter.js";
import { ExecutionTraceStore } from "./executionTrace.js";
import type { ExecutionTrace } from "./executionTrace.js";
import { classifyTrace, detectRegression } from "./traceClassifier.js";
import { checkDegradationAlert, createAlertCooldownTracker } from "./degradationAlert.js";
import { cleanupTraces } from "./traceCleanup.js";
import { renderTraceView } from "./traceViewer.js";
import {
  loadAndClassifyTraces,
  renderMiniReport,
  renderTraceReport,
} from "./traceReport.js";
import {
  InvalidSkillNameError,
  loadSkill,
  matchSkillCommand,
  SkillNotFoundError,
} from "./parser.js";
import { sanitizeFinalText } from "./outputSanitizer.js";
import { RouterState } from "./state.js";
import { executeSkill } from "./subAgent.js";
import type {
  JudgeRubric,
  ParsedSkill,
  PiHost,
  ExecutionRoute,
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

  /**
   * Additional text appended to every sub-agent system prompt, after the
   * AUGGIE_DIRECTIVE. Use this to inject domain-specific rules (e.g. DDD
   * enforcement) into sub-agent context.
   *
   * Accepts a static string (evaluated once at mount time) or a callback
   * (evaluated lazily at each execution). Use the callback form when the
   * appendix depends on mutable state (e.g. active bounded context).
   */
  systemPromptAppendix?: string | (() => string);

  /**
   * Additional MCP servers to attach to the sub-agent alongside auggie.
   * These are appended after the auggie MCP server spec.
   */
  additionalMcpServers?: import("./types.js").MCPServerSpec[];

  /**
   * Additional tool result middleware functions. These run after the
   * built-in overflow middleware, in the order given.
   */
  additionalToolMiddleware?: import("./types.js").ToolResultMiddleware[];
}

const LOCK_REASON = "pi-auggie-router: skill execution in progress";

function sanitizeOneLine(text: string, maxChars = 240): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function applyUnpassedJudgeRouteFloor(
  route: ExecutionRoute,
  passed: boolean
): { route: ExecutionRoute; minimumTier?: "balanced" } {
  if (passed) return { route };
  const flooredRoute: ExecutionRoute = route.tier === "cheap"
    ? { ...route, tier: "balanced" }
    : route;
  return { route: flooredRoute, minimumTier: "balanced" };
}

function makeRouteLogPayload(input: {
  skillName: string;
  originalRoute: ExecutionRoute;
  effectiveRoute: ExecutionRoute;
  selection: ExecutionRouteSelection;
}): string {
  const { skillName, originalRoute, effectiveRoute, selection } = input;
  return JSON.stringify({
    event: "auggie-router.execution-route",
    skill: skillName,
    tier: selection.tier,
    model: selection.model,
    source: selection.source,
    complexity: effectiveRoute.complexity,
    risk: effectiveRoute.risk,
    confidence: effectiveRoute.confidence,
    routeTier: originalRoute.tier,
    effectiveTier: effectiveRoute.tier,
  });
}

function formatExecutionMessage(input: {
  skillName: string;
  selection: ExecutionRouteSelection;
  surfaceDecision: boolean;
}): string {
  const { skillName, selection, surfaceDecision } = input;
  if (!surfaceDecision) {
    return `[System]: ⚙️ Executing /skill:${skillName} (Auggie semantic retrieval running...)`;
  }

  const reason = sanitizeOneLine(selection.reason);
  if (selection.source === "execution-routing") {
    return `[System]: ⚙️ Executing /skill:${skillName} using ${selection.tier} model ${selection.model}. Reason: ${reason}`;
  }
  if (selection.source === "skill-model") {
    return `[System]: ⚙️ Executing /skill:${skillName} using SKILL.md model ${selection.model}. Reason: ${reason}`;
  }
  return `[System]: ⚙️ Executing /skill:${skillName} using fallback model ${selection.model}. Reason: ${reason}`;
}

export function createRouter(host: PiHost, opts: CreateRouterOptions = {}): RouterHandle {
  const settings = loadSettings(host);
  const state = new RouterState();
  const cooldownTracker = createAlertCooldownTracker();
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

      const { route, minimumTier } = applyUnpassedJudgeRouteFloor(
        outcome.route,
        outcome.passed
      );

      const selection = chooseExecutionModel({
        skill,
        route,
        settings,
        minimumTier,
      });

      state.beginExecution();
      host.setInputLocked(true, LOCK_REASON);

      log("info", makeRouteLogPayload({
        skillName: skill.name,
        originalRoute: outcome.route,
        effectiveRoute: route,
        selection,
      }));

      // Track the tier the model actually runs at when adaptive routing chose
      // it (selection.tier captures post-preference/safety floors plus pool
      // fallback). For static / pinned / legacy-fallback paths the selection
      // tier is the neutral "balanced" sentinel, so use the Judge's
      // classification instead — that's the only meaningful signal.
      const budgetTier =
        selection.source === "execution-routing" ? selection.tier : route.tier;
      const budget = chooseContextBudget(settings, budgetTier);
      if (budget.active) {
        log(
          "info",
          JSON.stringify({
            event: "auggie-router.context-budget",
            skill: skill.name,
            tier: budget.tier,
            overflowCeilingBytes: budget.overflowCeilingBytes,
            source: budget.source,
          })
        );
      }

      host.postSystemMessage(formatExecutionMessage({
        skillName: skill.name,
        selection,
        surfaceDecision: settings.executionRouting.surfaceDecision,
      }));

      const resolvedModel = selection.model;

      // Create trace store if execution tracing is enabled.
      const traceStore = settings.executionTrace.enabled
        ? new ExecutionTraceStore(settings.executionTrace, {
            skillName: skill.name,
            model: resolvedModel,
            brief,
            route,
          })
        : undefined;

      try {
        const result = await executeSkill(host, settings, {
          skill,
          brief,
          resolvedModel,
          systemPromptAppendix: opts.systemPromptAppendix,
          additionalMcpServers: opts.additionalMcpServers,
          additionalToolMiddleware: opts.additionalToolMiddleware,
          overflowCeilingBytes: budget.overflowCeilingBytes,
          traceStore: traceStore ?? undefined,
          route,
        });
        const sanitized = sanitizeFinalText(
          result.finalText,
          settings.outputSanitizer
        );
        if (
          settings.outputSanitizer.enabled &&
          (sanitized.removedSections > 0 || sanitized.truncated)
        ) {
          log(
            "info",
            JSON.stringify({
              event: "auggie-router.output-sanitized",
              skill: skill.name,
              removedSections: sanitized.removedSections,
              truncated: sanitized.truncated,
              originalChars: sanitized.originalChars,
              finalChars: sanitized.finalChars,
            })
          );
        }
        host.postAssistantMessage(sanitized.text);
        if (result.stoppedReason !== "completed") {
          host.postSystemMessage(
            `[System]: Sub-agent stopped early (${result.stoppedReason}).`
          );
        }

        // Finalize and persist execution trace.
        if (traceStore && !traceStore.finalized) {
          try {
            const trace = traceStore.finalize(
              sanitized.text,
              result.stoppedReason
            );
            const workspaceRoot = host.resolveWorkspacePath(".");
            const filepath = traceStore.persist(trace, workspaceRoot);

            // Trace classification + structured log.
            const obsSettings = settings.traceObservability;
            if (obsSettings.enabled) {
              // Load recent history once — reused by regression detection,
              // degradation alerts, and the mini-report.
              const traceDir = host.resolveWorkspacePath(settings.executionTrace.traceDirectory);
              const recentTraces = ExecutionTraceStore.loadTraces(
                traceDir,
                skill.name
              );

              // Classify recent traces once — cached for degradation alert
              // and mini-report to avoid redundant classifyTrace() calls.
              const recentVerdicts = recentTraces.map((t, i) => {
                let v = classifyTrace(t);
                // Use remaining traces as history for regression detection.
                const history = recentTraces.slice(i + 1);
                v = detectRegression(v, t, history, obsSettings.regressionWindowSize);
                return v;
              });

              // Classify current trace with regression detection.
              let verdict = classifyTrace(trace);
              verdict = detectRegression(
                verdict,
                trace,
                recentTraces,
                obsSettings.regressionWindowSize
              );

              log(
                "info",
                JSON.stringify({
                  event: "auggie-router.trace-classified",
                  skill: skill.name,
                  outcome: verdict.outcome,
                  confidence: verdict.confidence,
                  signals: verdict.signals,
                  toolCalls: trace.toolCalls.length,
                  stoppedReason: trace.stoppedReason,
                  model: trace.model,
                  tier: trace.route.tier,
                })
              );

              // Degradation alert — check consecutive failures and
              // emit system message if threshold met.
              if (obsSettings.degradationAlertEnabled) {
                const alertResult = checkDegradationAlert(
                  verdict,
                  trace,
                  recentTraces,
                  recentVerdicts,
                  {
                    enabled: obsSettings.degradationAlertEnabled,
                    consecutiveFailures: obsSettings.degradationConsecutiveFailures,
                    cooldownHours: obsSettings.degradationAlertCooldownHours,
                    cooldownTracker,
                  }
                );
                if (alertResult.fired && alertResult.message) {
                  host.postSystemMessage(alertResult.message);
                  log(
                    "info",
                    JSON.stringify({
                      event: "auggie-router.degradation-alert",
                      skill: skill.name,
                      consecutiveFailures: obsSettings.degradationConsecutiveFailures,
                    })
                  );
                }
              }

              // Auto mini-report after execution (opt-in).
              // Reuses cached verdicts — includes regression detection.
              if (obsSettings.showReportAfterExecution) {
                try {
                  const miniInput = {
                    traces: [trace, ...recentTraces].slice(0, 3),
                    verdicts: [verdict, ...recentVerdicts.slice(0, 2)],
                  };
                  const miniReport = renderMiniReport(skill.name, miniInput);
                  host.postSystemMessage(miniReport);
                } catch (miniErr) {
                  log("debug", `pi-auggie-router: mini-report failed: ${(miniErr as Error).message}`);
                }
              }
            } else {
              // Observability disabled — emit basic trace log for debugging.
              log(
                "info",
                JSON.stringify({
                  event: "auggie-router.execution-trace",
                  skill: skill.name,
                  toolCalls: trace.toolCalls.length,
                  stoppedReason: trace.stoppedReason,
                  filepath,
                })
              );
            }

            // Count-based cleanup of old traces.
            const traceDir = host.resolveWorkspacePath(settings.executionTrace.traceDirectory);
            const deleted = cleanupTraces(traceDir, {
              maxTracesPerSkill: obsSettings.enabled
                ? obsSettings.maxTracesPerSkill
                : 20,
            });
            if (deleted > 0) {
              log("debug", `pi-auggie-router: cleaned up ${deleted} old trace file(s)`);
            }
          } catch (traceErr) {
            log("warn", `pi-auggie-router: trace persist failed: ${(traceErr as Error).message}`);
          } finally {
            traceStore.dispose();
          }
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

  // Intercept `/skill:trace-report <name>` and `/skill:trace-view <filename>`
  // as special sub-commands.
  const TRACE_REPORT_REGEX = /^\/skill:trace-report\s+([a-zA-Z0-9_-]+)/;
  const TRACE_VIEW_REGEX = /^\/skill:trace-view\s+([a-zA-Z0-9_.-]+\.json)\s*$/;

  function handleTraceReport(skillName: string): void {
    const obsSettings = settings.traceObservability;
    if (!obsSettings.enabled) {
      host.postSystemMessage("[System]: Trace observability is disabled.");
      return;
    }
    const traceDir = host.resolveWorkspacePath(settings.executionTrace.traceDirectory);
    const input = loadAndClassifyTraces(
      traceDir,
      skillName,
      obsSettings.reportMaxTraces,
      obsSettings.regressionWindowSize
    );
    // Note: trendWindowSize reuses regressionWindowSize — they're conceptually
    // related (both look at recent history). A dedicated trendWindowSize setting
    // can be added later if users need independent control.
    const report = renderTraceReport(skillName, input, {
      maxTraces: obsSettings.reportMaxTraces,
      maxInlineTraces: obsSettings.reportMaxInlineTraces,
      trendWindowSize: obsSettings.regressionWindowSize,
    });
    host.postSystemMessage(report);
    log(
      "info",
      JSON.stringify({
        event: "auggie-router.trace-report",
        skill: skillName,
        traceCount: input.traces.length,
      })
    );
  }

  function handleTraceView(filename: string): void {
    const obsSettings = settings.traceObservability;
    if (!obsSettings.enabled) {
      host.postSystemMessage("[System]: Trace observability is disabled.");
      return;
    }
    const traceDir = host.resolveWorkspacePath(settings.executionTrace.traceDirectory);
    const trace = ExecutionTraceStore.loadSingleTrace(traceDir, filename);
    if (!trace) {
      host.postSystemMessage(`[System]: Trace file "${filename}" not found.`);
      return;
    }
    const verdict = classifyTrace(trace);
    const view = renderTraceView(filename, trace, verdict);
    host.postSystemMessage(view);
    log(
      "info",
      JSON.stringify({
        event: "auggie-router.trace-view",
        filename,
        skill: trace.skillName,
        outcome: verdict.outcome,
        toolCalls: trace.toolCalls.length,
      })
    );
  }

  // Intercept `/skill:<name>` before Pi's default handler runs.
  const offInput = host.onUserInput((raw) => {
    // Check for trace-view sub-command first (most specific).
    const viewMatch = TRACE_VIEW_REGEX.exec(raw.trimStart());
    if (viewMatch) {
      handleTraceView(viewMatch[1]!);
      return { cancel: true };
    }

    // Check for trace-report sub-command.
    const reportMatch = TRACE_REPORT_REGEX.exec(raw.trimStart());
    if (reportMatch) {
      handleTraceReport(reportMatch[1]!);
      return { cancel: true };
    }

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

export {
  DEFAULT_CONTEXT_BUDGETS,
  DEFAULT_CONTEXT_MEMORY,
  DEFAULT_EXECUTION_ROUTING,
  DEFAULT_HISTORY_ASSEMBLY,
  DEFAULT_OUTPUT_SANITIZER,
  DEFAULT_PARALLEL_SUBAGENTS,
  DEFAULT_SETTINGS,
} from "./config.js";
export { DEFAULT_TRACE_OBSERVABILITY } from "./config.js";
export { chooseContextBudget } from "./contextBudget.js";
export type { EffectiveContextBudget } from "./contextBudget.js";
export { assembleHistory } from "./historyAssembler.js";
export { mapModel, DisallowedProviderError } from "./modelMapper.js";
export {
  matchSkillCommand,
  locateSkillFile,
  parseSkillFile,
  loadSkill,
  SkillNotFoundError,
  InvalidSkillNameError,
} from "./parser.js";
export { composeMiddleware, makeOverflowMiddleware, redactSecrets, runAuggieStatus, AUGGIE_DIRECTIVE, AUGGIE_MCP_NAME, AUGGIE_TOOL_NAME, CONTEXT_MEMORY_MCP_NAME, buildContextMemoryMcpSpec } from "./auggie.js";
export type { OverflowMiddlewareOptions } from "./auggie.js";
export { ContextMemoryStore } from "./contextMemory.js";
export type {
  ContextMemoryEntry,
  ContextMemoryStoreResult,
} from "./contextMemory.js";
export { runParallelSubagents } from "./parallelSubagents.js";
export type {
  ParallelExecutionInput,
  ParallelExecutionResult,
  WorkerResult,
  WorkerStoppedReason,
} from "./parallelSubagents.js";
export { ExecutionTraceStore, makeTraceMiddleware } from "./executionTrace.js";
export type {
  ExecutionTrace,
  ExecutionTraceStoreSettings,
  ToolCallEntry,
} from "./executionTrace.js";
export { cleanupTraces } from "./traceCleanup.js";
export type { TraceCleanupOptions } from "./traceCleanup.js";
export { buildSubAgentSystemPrompt, executeSkill } from "./subAgent.js";
export type { ExecutionInput } from "./subAgent.js";
export { sanitizeFinalText } from "./outputSanitizer.js";
export type { SanitizeResult } from "./outputSanitizer.js";
export { createExtensionBridge } from "./extensionBridge.js";
export type { BridgeOptions } from "./extensionBridge.js";
export { DEFAULT_EXECUTION_ROUTE,
  coerceExecutionRoute,
  runActorJudgeLoop,
} from "./actorJudge.js";
export type { JudgeOutcome } from "./actorJudge.js";
export { chooseExecutionModel } from "./executionRouter.js";
export type {
  ChooseExecutionModelInput,
  ExecutionRouteSelection,
} from "./executionRouter.js";
export { classifyTrace, detectRegression, extractSignalPrefix, OUTCOME_EMOJI, formatTraceDuration } from "./traceClassifier.js";
export type { TraceOutcome, TraceVerdict } from "./traceClassifier.js";
export { checkDegradationAlert, createAlertCooldownTracker, resetAlertCooldowns } from "./degradationAlert.js";
export type { DegradationAlertConfig, DegradationAlertResult } from "./degradationAlert.js";
export {
  loadAndClassifyTraces,
  renderMiniReport,
  renderTraceReport,
} from "./traceReport.js";
export type { TraceReportConfig, TraceReportInput } from "./traceReport.js";
export { renderTraceView } from "./traceViewer.js";
export type { TraceViewConfig } from "./traceViewer.js";
export { RouterState } from "./state.js";
export type {
  ChatMessage,
  ContextBudgetSettings,
  ContextMemorySettings,
  ExecutionRoute,
  ExecutionRoutingPreference,
  ExecutionRoutingSettings,
  ExecutionRoutingTier,
  HistoryAssemblySettings,
  HistoryMiddleMode,
  HistoryStrategy,
  JudgeRubric,
  LLMCallOptions,
  LLMResponse,
  MCPServerSpec,
  OutputSanitizerSettings,
  ParallelSubagentsSettings,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
  SkillModelPolicy,
  SubAgentResult,
  SubAgentRunOptions,
  SubtaskBrief,
  ToolCallContext,
  ToolResultMiddleware,
  TraceObservabilitySettings,
  UIInputInterceptor,
} from "./types.js";
