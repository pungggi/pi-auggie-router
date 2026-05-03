import type {
  ChatMessage,
  JudgeRubric,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
} from "./types.js";

const ACTOR_SYSTEM_PROMPT = `You are the Actor model in a 2-pass skill-routing loop.
You produce a concise "Skill Execution Brief" for a downstream sub-agent.
Output STRICT JSON only, no prose, matching this schema:
{
  "userGoal": string,            // single sentence; what the user actually wants
  "constraints": string[],       // explicit limits, file scopes, must/must-not
  "knownContext": string         // condensed facts already established in chat
}
Rules:
- Pull only from the provided chat history and the SKILL instructions.
- Do not invent files, function names, or requirements.
- If a constraint is missing, leave it out — do not guess.`;

const JUDGE_SYSTEM_PROMPT = `You are the Judge model in a 2-pass skill-routing loop.
You evaluate whether the Actor's brief is sufficient to begin execution.
Output STRICT JSON only, no prose, matching this schema:
{
  "hasUserGoal": boolean,
  "hasRequiredInputs": boolean,
  "hasScopeBoundary": boolean,
  "isUnambiguous": boolean,
  "missingRequirementQuestion": string | null
}
Rules:
- Set each boolean true only if the brief satisfies it on its own merit.
- If any boolean is false, populate "missingRequirementQuestion" with ONE
  short, user-facing question that would unblock execution.
- If all booleans are true, "missingRequirementQuestion" must be null.`;

export interface JudgeOutcome {
  brief: SkillBrief;
  rubric: JudgeRubric;
  /** True iff every required boolean passed. */
  passed: boolean;
  /** Number of Actor passes performed (1 or 2). */
  iterations: number;
}

function rubricPassed(r: JudgeRubric): boolean {
  return r.hasUserGoal && r.hasRequiredInputs && r.hasScopeBoundary && r.isUnambiguous;
}

/**
 * Best-effort JSON extraction. Models occasionally wrap output in code fences
 * even when told not to; we strip those before parsing.
 */
function extractJson(text: string): unknown {
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  return JSON.parse(trimmed);
}

function buildActorMessages(
  skill: ParsedSkill,
  history: ChatMessage[],
  priorBrief: SkillBrief | null,
  judgeFeedback: JudgeRubric | null
): ChatMessage[] {
  const historyBlock = history
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n");

  const revisionBlock =
    priorBrief && judgeFeedback
      ? `\n\nPRIOR BRIEF (rejected):\n${JSON.stringify(priorBrief, null, 2)}` +
        `\n\nJUDGE FEEDBACK:\n${JSON.stringify(judgeFeedback, null, 2)}` +
        `\nRewrite the brief to address the failed booleans.`
      : "";

  return [
    { role: "system", content: ACTOR_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `SKILL: ${skill.name}\n\nSKILL INSTRUCTIONS:\n${skill.instructions}\n\n` +
        `RECENT CHAT (last ${history.length}):\n${historyBlock}` +
        revisionBlock,
    },
  ];
}

function buildJudgeMessages(
  skill: ParsedSkill,
  history: ChatMessage[],
  brief: SkillBrief
): ChatMessage[] {
  const historyBlock = history.map((m) => `[${m.role}] ${m.content}`).join("\n");
  return [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `SKILL: ${skill.name}\n\nSKILL INSTRUCTIONS:\n${skill.instructions}\n\n` +
        `RECENT CHAT:\n${historyBlock}\n\n` +
        `ACTOR BRIEF:\n${JSON.stringify(brief, null, 2)}`,
    },
  ];
}

function coerceBrief(raw: unknown): SkillBrief {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    userGoal: typeof obj.userGoal === "string" ? obj.userGoal : "",
    constraints: Array.isArray(obj.constraints)
      ? obj.constraints.filter((c): c is string => typeof c === "string")
      : [],
    knownContext: typeof obj.knownContext === "string" ? obj.knownContext : "",
    userClarifications: [],
  };
}

function coerceRubric(raw: unknown): JudgeRubric {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const q = obj.missingRequirementQuestion;
  return {
    hasUserGoal: obj.hasUserGoal === true,
    hasRequiredInputs: obj.hasRequiredInputs === true,
    hasScopeBoundary: obj.hasScopeBoundary === true,
    isUnambiguous: obj.isUnambiguous === true,
    missingRequirementQuestion: typeof q === "string" && q.trim() ? q.trim() : undefined,
  };
}

/**
 * Race the routing-LLM call against `routingTimeoutMs`. On timeout we abort
 * the request (so the host can stop billing) and resolve with empty text,
 * which the caller's coerce* fallbacks turn into a "missing context" rubric.
 */
async function callWithTimeout(
  host: PiHost,
  opts: Parameters<PiHost["callLLM"]>[0],
  timeoutMs: number
): Promise<{ text: string; timedOut: boolean }> {
  if (timeoutMs <= 0) {
    const r = await host.callLLM(opts);
    return { text: r.text, timedOut: false };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await host.callLLM({ ...opts, signal: ctrl.signal });
    return { text: r.text, timedOut: false };
  } catch (err) {
    if (ctrl.signal.aborted) return { text: "", timedOut: true };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the 2-pass Actor/Judge loop. Returns the final brief + judge verdict.
 * Caller decides what to do when `passed === false` (typically: trigger Q&A).
 */
export async function runActorJudgeLoop(
  host: PiHost,
  settings: RouterSettings,
  skill: ParsedSkill
): Promise<JudgeOutcome> {
  const history = host.getRecentMessages(settings.historyWindow);

  let priorBrief: SkillBrief | null = null;
  let priorRubric: JudgeRubric | null = null;
  let lastBrief: SkillBrief = {
    userGoal: "",
    constraints: [],
    knownContext: "",
    userClarifications: [],
  };
  let lastRubric: JudgeRubric = {
    hasUserGoal: false,
    hasRequiredInputs: false,
    hasScopeBoundary: false,
    isUnambiguous: false,
  };

  for (let i = 1; i <= settings.maxJudgeIterations; i++) {
    const actorRes = await callWithTimeout(
      host,
      {
        model: settings.routingModel,
        messages: buildActorMessages(skill, history, priorBrief, priorRubric),
        temperature: 0.0,
        responseFormat: "json",
      },
      settings.routingTimeoutMs
    );

    let brief: SkillBrief;
    try {
      brief = coerceBrief(extractJson(actorRes.text));
    } catch {
      // Treat malformed Actor output as a hard failure of this pass; let the
      // Judge see an empty brief so it can request clarification.
      brief = {
        userGoal: "",
        constraints: [],
        knownContext: "",
        userClarifications: [],
      };
    }

    const judgeRes = await callWithTimeout(
      host,
      {
        model: settings.routingModel,
        messages: buildJudgeMessages(skill, history, brief),
        temperature: 0.0,
        responseFormat: "json",
      },
      settings.routingTimeoutMs
    );

    let rubric: JudgeRubric;
    try {
      rubric = coerceRubric(extractJson(judgeRes.text));
    } catch {
      rubric = {
        hasUserGoal: false,
        hasRequiredInputs: false,
        hasScopeBoundary: false,
        isUnambiguous: false,
        missingRequirementQuestion: judgeRes.timedOut
          ? "Routing model timed out. Could you restate the goal more specifically?"
          : "Could you restate what you want this skill to do, and on which files?",
      };
    }

    lastBrief = brief;
    lastRubric = rubric;

    if (rubricPassed(rubric)) {
      return { brief, rubric, passed: true, iterations: i };
    }

    priorBrief = brief;
    priorRubric = rubric;
  }

  return {
    brief: lastBrief,
    rubric: lastRubric,
    passed: false,
    iterations: settings.maxJudgeIterations,
  };
}
