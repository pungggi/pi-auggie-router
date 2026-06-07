# Reddit Outreach Plan – pi-auggie-router Feedback

**Goal:** Get genuine usage/feedback from people who actively use BOTH Pi.dev and Auggie.

**Core Principle (everywhere):** 90/10 value-first. Comment thoughtfully before posting anything promotional. Be transparent that you're the author. Focus on learning user pain points.

---

## Recommended Subreddits (Ranked)

| Priority | Subreddit            | Why It Fits                                      | Risk Level | Notes |
|----------|----------------------|--------------------------------------------------|------------|-------|
| 1        | r/PiCodingAgent      | Dedicated Pi community, extensions & workflows   | Low        | Highest signal audience |
| 2        | r/LocalLLM / r/LocalLLaMA | Existing Pi discussions, technical users      | Medium     | Good for model/cost angle |
| 3        | r/AI_Agents          | Broader agent community, has weekly project thread | Medium   | Must use weekly thread only |
| 4        | r/AugmentCodeAI      | Official Auggie subreddit                        | High       | Strict "no promotion" rule – consider avoiding |

---

## Phase 1: Preparation (Days 1–3) – No Links, No Self-Promo

**Actions:**
1. Join all four subreddits above.
2. Sort by "New" or "Hot".
3. Read the last 10–15 posts + comments in each.
4. Leave **thoughtful, non-promotional comments** on at least 6–8 existing threads.

**Good topics for Phase 1 comments:**
- r/PiCodingAgent: sub-agents, model routing, extension recommendations, BMAD method, multi-model workflows, token efficiency.
- r/LocalLLM / r/LocalLLaMA: Qwen + Pi experiences, local vs cloud tradeoffs, cost/usage patterns.
- r/AI_Agents: participate in the weekly project display thread.

**Goal:** Build natural visibility and karma before you post.

---

## Phase 2: Primary Launch – r/PiCodingAgent (Days 4–7)

This is your **highest-signal, lowest-risk** target.

**Post type:** Standalone post (not a reply).

**Suggested Titles (choose one):**
- "Anyone here actively using both Pi and Auggie? Curious about your model/tool switching patterns"
- "Looking for real feedback: people who route between Pi and Auggie — what actually hurts?"
- "Pi + Auggie workflow question — when do you reach for one vs the other?"

**Post Body Structure (keep it short):**

1. **One-sentence context**  
   "I've been using Pi heavily and occasionally reach for Auggie when..."

2. **Honest problem statement**  
   "The constant context/model/cost decision is getting annoying, so I started experimenting with a small router..."

3. **Specific questions you want answered:**
   - When do you decide to switch tools mid-session?
   - What signals matter most (task type, context size, cost, model strength)?
   - Any existing routing patterns or scripts you're already using?
   - Would an automatic router based on those signals be useful?

4. **Close**  
   "Would genuinely appreciate real workflows. Happy to share what I've tried so far in the comments."

**Tone:** Curious + collaborative. Never "I built this, please try it".

---

## Phase 3: Secondary Targets – r/LocalLLM & r/LocalLLaMA (Days 7–10)

**Angle:** More technical (model tiers, cost, local vs API routing).

**Options:**
- Create a similar standalone post after Phase 1 commenting.
- Or reply to existing Pi threads with genuine comments that naturally surface the routing problem.

**Title variation:**
"Pi users running local Qwen/Mixtral + occasional Auggie — how do you decide which model tier to use per turn?"

---

## Phase 4: Tertiary – r/AI_Agents (Only if desired)

**Strict rule:** Only post **inside** the existing **"Weekly Thread: Project Display"**.

Do **not** create a top-level post.

**Example content for the weekly thread:**
"pi-auggie-router – lightweight intelligent router that hands tasks between Pi and Auggie based on intent, budget, and context size. Early feedback wanted from anyone using both tools daily."

---

## Ready-to-Use Message Templates

### Template A – r/PiCodingAgent Standalone Post

**Title:** Anyone running both Pi and Auggie? Model switching is killing my flow

**Body:**
```
I've been in Pi almost daily and sometimes jump to Auggie for heavier reasoning tasks.

The constant context/model/cost decision is getting annoying, so I started experimenting with a tiny router extension.

Curious how other people handle this:
- Do you have any rule of thumb for when to switch?
- Task type? Context size? Model strength? Cost?
- Anyone already scripting this kind of routing?

Would genuinely appreciate real workflows — not trying to sell anything, just trying to make my own life less painful.

Happy to share what I've hacked together so far if people are interested.
```

---

### Template B – Comment-Style Reply (works in any sub)

```
I'm in the same boat. I ended up writing a small router that looks at task intent + current session budget and decides whether to stay in Pi or hand off to Auggie for that turn.

Still early, but the signals I'm using are: [task complexity], [remaining context budget], [model cost tier]. Curious if that matches what you're doing manually.
```

---

## Timeline Summary

| Phase | Days   | Subreddit(s)                  | Action                              | Risk |
|-------|--------|-------------------------------|-------------------------------------|------|
| 1     | 1–3    | All                           | Thoughtful comments on 6–8 posts    | None |
| 2     | 4–7    | r/PiCodingAgent               | Standalone feedback post            | Low  |
| 3     | 7–10   | r/LocalLLM / r/LocalLLaMA     | Post or targeted comments           | Medium |
| 4     | 10+    | r/AI_Agents (weekly thread only) | Only inside project display thread | Higher |

---

## Important Reminders

- **Never** lead with the repo link. Let people ask.
- **Always** disclose you're the author when it naturally comes up.
- **r/AugmentCodeAI** has an explicit "No promotion of services or products" rule. Consider skipping it entirely.
- Focus on **learning** rather than **promoting**. The goal is signal, not hype.

---

## Next Steps

If you want, I can:
1. Refine the post templates with more specific questions based on what `pi-auggie-router` actually does.
2. Draft 4–5 high-quality Phase 1 comment replies you can copy-paste.
3. Create a version focused more on the Auggie side.

---

*Plan created: 2026-05-29*  
*For: alessandro@pungitore.ch*