import type {
  ChatMessage,
  ExecutionRoute,
  ExecutionRoutingTier,
  JudgeRubric,
  ParsedSkill,
  PiHost,
  RouterSettings,
  SkillBrief,
} from "./types.js";

/**
 * Phase-2 fallback route used when Judge output omits or malforms
 * `executionRoute`. Matches PRD §9.
 */
export const DEFAULT_EXECUTION_ROUTE: ExecutionRoute = {
  tier: "balanced",
  complexity: "medium",
  risk: "unknown",
  confidence: 0,
  reason: "Routing metadata unavailable; using balanced default.",
};

const TIER_SET: ReadonlySet<ExecutionRoutingTier> = new Set([
  "cheap",
  "balanced",
  "frontier",
]);
const COMPLEXITY_SET: ReadonlySet<ExecutionRoute["complexity"]> = new Set([
  "low",
  "medium",
  "high",
]);
const RISK_SET: ReadonlySet<ExecutionRoute["risk"]> = new Set([
  "read_only",
  "small_edit",
  "multi_file_edit",
  "architecture_change",
  "unknown",
]);
const MAX_REASON_CHARS = 500;

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
You evaluate whether the Actor's brief is sufficient to begin execution AND
classify the task so a host router can pick an appropriately-sized model.
Output STRICT JSON only, no prose, matching this schema:
{
  "hasUserGoal": boolean,
  "hasRequiredInputs": boolean,
  "hasScopeBoundary": boolean,
  "isUnambiguous": boolean,
  "missingRequirementQuestion": string | null,
  "executionRoute": {
    "tier": "cheap" | "balanced" | "frontier",
    "complexity": "low" | "medium" | "high",
    "risk": "read_only" | "small_edit" | "multi_file_edit" | "architecture_change" | "unknown",
    "confidence": number,        // 0..1
    "reason": string             // <= 500 chars; explain the tier choice
  }
}
Rules:
- Set each boolean true only if the brief satisfies it on its own merit.
- If any boolean is false, populate "missingRequirementQuestion" with ONE
  short, user-facing question that would unblock execution.
- If all booleans are true, "missingRequirementQuestion" must be null.
- Always emit "executionRoute"; if the brief is too thin, lower "confidence"
  and choose at least "balanced".
- Prefer the cheapest tier likely to complete the task well.
- Route read-only or context-only tasks (explanations, summaries, lookups,
  documentation drafting) to "cheap".
- Route risky multi-file or architecture/design changes to "frontier".
- Do not pick "frontier" merely because code is involved; reserve it for
  genuine complexity or risk.
- Keep "reason" terse and stable. Do not include timestamps, run IDs, model
  names, provider hints, or cost estimates — that data busts caches and the
  sub-agent must never see its own routing decision.`;

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
  /**
   * Routing metadata produced by the Judge alongside the rubric.
   * Always populated — falls back to {@link DEFAULT_EXECUTION_ROUTE}
   * when missing, malformed, or extracted from a failing parse.
   */
  route: ExecutionRoute;
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

/**
 * Coerce a raw `executionRoute` object from the Judge response into a
 * fully-typed {@link ExecutionRoute}, defaulting any invalid or missing
 * field. Never throws. The full default is returned when the input is
 * not an object.
 */
export function coerceExecutionRoute(raw: unknown): ExecutionRoute {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_EXECUTION_ROUTE };
  }
  const obj = raw as Record<string, unknown>;

  const tier =
    typeof obj.tier === "string" &&
    (TIER_SET as ReadonlySet<string>).has(obj.tier)
      ? (obj.tier as ExecutionRoutingTier)
      : DEFAULT_EXECUTION_ROUTE.tier;

  const complexity =
    typeof obj.complexity === "string" &&
    (COMPLEXITY_SET as ReadonlySet<string>).has(obj.complexity)
      ? (obj.complexity as ExecutionRoute["complexity"])
      : DEFAULT_EXECUTION_ROUTE.complexity;

  const risk =
    typeof obj.risk === "string" &&
    (RISK_SET as ReadonlySet<string>).has(obj.risk)
      ? (obj.risk as ExecutionRoute["risk"])
      : DEFAULT_EXECUTION_ROUTE.risk;

  let confidence = DEFAULT_EXECUTION_ROUTE.confidence;
  if (typeof obj.confidence === "number" && Number.isFinite(obj.confidence)) {
    confidence = Math.min(1, Math.max(0, obj.confidence));
  }

  let reason = DEFAULT_EXECUTION_ROUTE.reason;
  if (typeof obj.reason === "string") {
    const trimmed = obj.reason.trim();
    if (trimmed) {
      reason =
        trimmed.length > MAX_REASON_CHARS
          ? trimmed.slice(0, MAX_REASON_CHARS)
          : trimmed;
    }
  }

  return { tier, complexity, risk, confidence, reason };
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
  let callPromise: Promise<{ text: string; timedOut: boolean }> =
    Promise.resolve({ text: "", timedOut: false });
  try {
    callPromise = host
      .callLLM({ ...opts, signal: ctrl.signal })
      .then((r) => ({ text: r.text, timedOut: false as const }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return { text: "", timedOut: true as const };
        throw err;
      });
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
  let lastRoute: ExecutionRoute = { ...DEFAULT_EXECUTION_ROUTE };

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
    let route: ExecutionRoute;
    try {
      const parsed = extractJson(judgeRes.text);
      rubric = coerceRubric(parsed);
      const rawRoute =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).executionRoute
          : undefined;
      route = coerceExecutionRoute(rawRoute);
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
      route = { ...DEFAULT_EXECUTION_ROUTE };
    }

    lastBrief = brief;
    lastRubric = rubric;
    lastRoute = route;

    if (rubricPassed(rubric)) {
      return { brief, rubric, passed: true, iterations: i, route };
    }

    priorBrief = brief;
    priorRubric = rubric;
  }

  return {
    brief: lastBrief,
    rubric: lastRubric,
    passed: false,
    iterations: settings.maxJudgeIterations,
    route: lastRoute,
  };
}
