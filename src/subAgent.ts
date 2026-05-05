import {
  AUGGIE_DIRECTIVE,
  buildAuggieMcpSpec,
  composeMiddleware,
  makeOverflowMiddleware,
} from "./auggie.js";
import type {
  MCPServerSpec,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
  SubAgentResult,
  ToolResultMiddleware,
} from "./types.js";

export interface ExecutionInput {
  skill: ParsedSkill;
  brief: SkillBrief;
  /** Already mapped to the gateway-qualified ID. */
  resolvedModel: string;
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
  additionalMcpServers?: MCPServerSpec[];
  /**
   * Additional tool result middleware functions. These run after the
   * built-in overflow middleware, in the order given.
   */
  additionalToolMiddleware?: ToolResultMiddleware[];
}

function renderBrief(brief: SkillBrief): string {
  const parts: string[] = [];
  parts.push(`User Goal: ${brief.userGoal || "(unspecified)"}`);
  if (brief.constraints.length) {
    parts.push(`Constraints:\n- ${brief.constraints.join("\n- ")}`);
  }
  if (brief.knownContext.trim()) {
    parts.push(`Known Context:\n${brief.knownContext.trim()}`);
  }
  if (brief.userClarifications.length) {
    parts.push(
      `User Clarifications:\n- ${brief.userClarifications.join("\n- ")}`
    );
  }
  return parts.join("\n\n");
}

export async function executeSkill(
  host: PiHost,
  settings: RouterSettings,
  input: ExecutionInput
): Promise<SubAgentResult> {
  // Resolve the appendix: evaluate callbacks lazily so active-context
  // changes are picked up between skill executions.
  const rawAppendix = input.systemPromptAppendix;
  const appendix = typeof rawAppendix === "function" ? rawAppendix() : rawAppendix;

  const promptParts = [
    input.skill.instructions,
    "",
    AUGGIE_DIRECTIVE,
    appendix ?? "",
  ].filter(p => p !== "");

  const systemPrompt = promptParts.join("\n\n");

  const middleware = input.additionalToolMiddleware?.length
    ? composeMiddleware(
        makeOverflowMiddleware(settings.overflowCeilingBytes),
        ...input.additionalToolMiddleware,
      )
    : makeOverflowMiddleware(settings.overflowCeilingBytes);

  return host.runSubAgent({
    model: input.resolvedModel,
    systemPrompt,
    userPrompt: renderBrief(input.brief),
    temperature: settings.subAgentTemperature,
    mcpServers: [
      buildAuggieMcpSpec(settings),
      ...(input.additionalMcpServers ?? []),
    ],
    toolResultMiddleware: middleware,
    totalTimeoutMs: settings.totalTimeoutMs,
    inactivityTimeoutMs: settings.inactivityTimeoutMs,
  });
}
