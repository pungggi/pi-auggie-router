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

/** SEC-05: maximum LLM response size before JSON.parse (256 KB). */
const MAX_LLM_RESPONSE_BYTES = 256 * 1024;

/** SEC-09: maximum length of a single chat message injected into prompts. */
const MAX_MESSAGE_CHARS = 10_000;

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
 *
 * SEC-05: rejects inputs exceeding MAX_LLM_RESPONSE_BYTES to prevent
 * memory exhaustion from a compromised or misbehaving routing model.
 */
function extractJson(text: string): unknown {
  const byteLen = Buffer.byteLength(text, "utf8");
  if (byteLen > MAX_LLM_RESPONSE_BYTES) {
    throw new Error(
      `LLM response too large to parse (${byteLen} bytes > ${MAX_LLM_RESPONSE_BYTES})`
    );
  }
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  return JSON.parse(trimmed);
}

/**
 * SEC-09: truncate individual messages to MAX_MESSAGE_CHARS before
 * including them in routing prompts, limiting exposure of large
 * pasted content (logs, secrets, file dumps) to the routing model.
 */
function truncateMessage(content: string): string {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  return content.slice(0, MAX_MESSAGE_CHARS) + "\n[...truncated]";
}

function buildActorMessages(
  skill: ParsedSkill,
  history: ChatMessage[],
  priorBrief: SkillBrief | null,
  judgeFeedback: JudgeRubric | null
): ChatMessage[] {
  const historyBlock = history
    .map((m) => `[${m.role}] ${truncateMessage(m.content)}`)
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
  const historyBlock = history
    .map((m) => `[${m.role}] ${truncateMessage(m.content)}`)
    .join("\n");
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
 * Race the routing-LLM call against `routingTimeoutMs`.
 *
 * The race is enforced by `Promise.race`, not by trusting the host to honour
 * `AbortSignal`. If the host ignores the signal, its promise stays pending —
 * but the timeout branch wins the race and `callWithTimeout` resolves with
 * `{ text: "", timedOut: true }`, so the caller is never blocked beyond
 * `timeoutMs`. The signal is still passed so well-behaved hosts can stop
 * upstream billing; the still-pending request is left as host-managed
 * detritus that the GC will reap once it finally settles.
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
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ text: string; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve({ text: "", timedOut: true });
    }, timeoutMs);
  });
  const callPromise = host
    .callLLM({ ...opts, signal: ctrl.signal })
    .then((r) => ({ text: r.text, timedOut: false as const }))
    .catch((err: unknown) => {
      if (ctrl.signal.aborted) return { text: "", timedOut: true as const };
      throw err;
    });
  try {
    return await Promise.race([callPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    // Swallow any later rejection from a still-running call so it doesn't
    // surface as an unhandled promise rejection after the race resolved.
    callPromise.catch(() => {});
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
