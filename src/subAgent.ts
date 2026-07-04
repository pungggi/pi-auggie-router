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
  /**
   * Live overflow ceiling getter; falls back to the static
   * `settings.overflowCeilingBytes` when absent.
   */
  overflowCeiling?: () => number;
}

/**
 * Custom instructions are inherited verbatim, but bounded: a runaway
 * host-side instruction blob must not eat the sub-agent's token budget.
 */
const HOST_INSTRUCTIONS_MAX_CHARS = 4_000;

/**
 * Optional host-context block sourced from Pi >= 0.78.1 helpers
 * (`ctx.mode`, `ctx.getSystemPromptOptions()`). The host's base system
 * prompt is deliberately NOT inlined — only the mode hint and the user's
 * custom instructions carry over.
 */
function renderHostContext(host: PiHost): string | null {
  const parts: string[] = [];

  const mode = host.getMode?.()?.trim();
  if (mode) {
    parts.push(
      `Host mode: ${mode}. Adapt your behaviour to this mode ` +
        `(e.g. in a plan/read-only mode, propose changes instead of applying them).`
    );
  }

  let custom = host.getSystemPromptOptions?.()?.customInstructions?.trim();
  if (custom) {
    if (custom.length > HOST_INSTRUCTIONS_MAX_CHARS) {
      custom = custom.slice(0, HOST_INSTRUCTIONS_MAX_CHARS) + "\n[...truncated]";
    }
    parts.push(`Host custom instructions (inherited from the main thread):\n${custom}`);
  }

  return parts.length ? parts.join("\n\n") : null;
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
  const hostContext = renderHostContext(host);
  const systemPrompt = [
    input.skill.instructions,
    ...(hostContext ? ["", hostContext] : []),
    "",
    AUGGIE_DIRECTIVE,
  ].join("\n");

  return host.runSubAgent({
    model: input.resolvedModel,
    systemPrompt,
    userPrompt: renderBrief(input.brief),
    temperature: settings.subAgentTemperature,
    mcpServers: [buildAuggieMcpSpec()],
    toolResultMiddleware: makeOverflowMiddleware(
      input.overflowCeiling ?? settings.overflowCeilingBytes
    ),
    totalTimeoutMs: settings.totalTimeoutMs,
    inactivityTimeoutMs: settings.inactivityTimeoutMs,
  });
}
