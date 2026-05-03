import {
  AUGGIE_DIRECTIVE,
  buildAuggieMcpSpec,
  makeOverflowMiddleware,
} from "./auggie.js";
import type {
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
  SubAgentResult,
} from "./types.js";

export interface ExecutionInput {
  skill: ParsedSkill;
  brief: SkillBrief;
  /** Already mapped to the gateway-qualified ID. */
  resolvedModel: string;
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
  const systemPrompt = [input.skill.instructions, "", AUGGIE_DIRECTIVE].join("\n");

  return host.runSubAgent({
    model: input.resolvedModel,
    systemPrompt,
    userPrompt: renderBrief(input.brief),
    temperature: settings.subAgentTemperature,
    mcpServers: [buildAuggieMcpSpec(settings)],
    toolResultMiddleware: makeOverflowMiddleware(settings.overflowCeilingBytes),
    totalTimeoutMs: settings.totalTimeoutMs,
    inactivityTimeoutMs: settings.inactivityTimeoutMs,
  });
}
