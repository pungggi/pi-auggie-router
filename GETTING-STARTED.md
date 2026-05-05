# Getting Started

This guide walks you through setting up `pi-auggie-router` and creating your first skill workflow.

## Prerequisites

1. **Node.js ≥ 20.6**
2. **Augment Code CLI** (`auggie`) installed and running:
   ```bash
   auggie status  # Should exit 0 and show "connected"
   ```
   [Install Augment Code](https://www.augmentcode.com/)

3. **A Pi host** — an application that integrates the Pi framework. If you're building a Pi extension or using a Pi-compatible host, you can mount this router.

## Installation

```bash
npm install pi-auggie-router
```

## Step 1: Mount the Router in Your Pi Host

In your Pi host application code:

```ts
import { createRouter } from "pi-auggie-router";

// Your host must satisfy the PiHost interface:
// - postSystemMessage, postAssistantMessage, setInputLocked
// - getRecentMessages, callLLM, runSubAgent
// - onUserInput, onBeforeMessage
// - resolveWorkspacePath, resolveHomePath
// - log (optional)

const router = createRouter(piHost, {
  // Optional: pre-flight hook override (for tests)
  preflight: async () => {
    // Custom auggie health check
    return { ok: true, detail: "" };
  },

  // Optional: append domain-specific rules to every sub-agent
  systemPromptAppendix: `
    When working with this codebase, follow DDD patterns:
    - Keep business logic in domain services
    - Use repositories for data access
    - Emit domain events for state changes
  `,

  // Optional: attach additional MCP servers
  additionalMcpServers: [
    {
      name: "my-mcp",
      command: "node",
      args: ["./my-mcp-server.js"],
    },
  ],

  // Optional: custom tool result middleware
  additionalToolMiddleware: [
    (ctx, result) => {
      if (ctx.serverName === "my-mcp" && ctx.toolName === "expensive") {
        // Block or rewrite tool results
        return { block: true, replacement: "Tool output too large; refine query." };
      }
      return { block: false };
    },
  ],
});

// When shutting down:
router.dispose();
```

## Step 2: Configure Settings (Optional)

Create `.pi/settings.json` in your workspace:

```json
{
  "auggieRouter": {
    "defaultProvider": "openrouter",
    "routingModel": "anthropic/claude-3-5-haiku",
    "executionRouting": {
      "enabled": true,
      "preference": "balanced",
      "surfaceDecision": true,
      "models": {
        "cheap": "anthropic/claude-3-5-haiku",
        "balanced": "anthropic/claude-3-5-sonnet",
        "frontier": "anthropic/claude-3-7-sonnet"
      }
    }
  }
}
```

Default values work for most cases. See [README.md](README.md#configuration) for all options.

## Step 3: Create Your First Skill

Skills live in `.pi/skills/<name>/SKILL.md` (workspace) or `~/.pi/agent/skills/<name>/SKILL.md` (user). Workspace skills take precedence.

### Example: Simple Refactor

Create `.pi/skills/refactor/SKILL.md`:

```markdown
---
model: claude-3-5-sonnet
---

You are a code refactoring assistant.

Your goal is to improve code quality while preserving exact behavior:
- Simplify complex functions by extracting helper functions
- Rename variables and functions to be self-documenting
- Remove dead code and unused imports
- Apply consistent formatting (Prettier style)
- Add JSDoc comments for public functions

Constraints:
- Do not change the public API of exported functions
- Do not modify test files
- Do not change business logic
- Always run the linter after refactoring
```

### Example: Add Unit Tests

Create `.pi/skills/test/SKILL.md`:

```markdown
---
---

You are a test-driven development assistant.

Your goal is to add comprehensive unit tests for the code provided in context.

Requirements:
- Use Jest (or the project's test framework)
- Test all public functions and methods
- Include edge cases and error conditions
- Mock external dependencies
- Keep tests readable and well-organized

Constraints:
- Do not modify the source code under test
- Add tests in the same directory as the source
- Use descriptive test names that describe the behavior
```

### Example: With Adaptive Routing

Create `.pi/skills/explain/SKILL.md`:

```markdown
---
# No model specified → adaptive routing will choose based on task complexity
---

You are a code explanation assistant.

Your goal is to explain code clearly to a developer who may not be familiar with the codebase.

For each function or class:
- Explain its purpose in one sentence
- Describe its inputs and outputs
- Note any important side effects
- Call out non-obvious patterns or anti-patterns

Keep explanations concise (2-3 sentences per function). Focus on the "why", not just the "what".
```

With adaptive routing enabled and `preference: "balanced"`, this read-only task may route to a cheaper model.

## Step 4: Run Your Skill

In your Pi host interface, type:

```
/skill:refactor Clean up src/utils/auth.ts
```

The router will:

1. Intercept the command and load `.pi/skills/refactor/SKILL.md`
2. Run the Actor/Judge loop to classify the task and gather context
3. Select the execution model (from `model:` frontmatter or adaptive routing)
4. Spin up a sub-agent with the Augment Code MCP attached
5. The sub-agent uses `codebase-retrieval` to fetch relevant code
6. Apply the skill's instructions and produce the result
7. Display the result in the main thread

## Step 5: Example Session

**User:**
```
/skill:test Add tests for src/services/user.ts
```

**System:**
```
[System]: ⚙️ Executing /skill:test (Auggie semantic retrieval running...)
```

**Assistant:**
```
I'll add comprehensive unit tests for `src/services/user.ts`.

Let me first retrieve the relevant code...
[sub-agent uses codebase-retrieval MCP tool]

Here are the tests I've added:

```typescript
// src/services/user.test.ts
import { UserService } from './user';
import { mockUserRepository } from '../mocks';

describe('UserService', () => {
  describe('findById', () => {
    it('returns the user when found', async () => {
      // ...
    });

    it('returns null when user not found', async () => {
      // ...
    });

    it('handles repository errors gracefully', async () => {
      // ...
    });
  });
});
```

All tests cover the public API, edge cases, and error conditions.
```

## Troubleshooting

### Augment daemon offline

```
[System Error]: Cannot execute skill. Augment daemon is offline or unauthenticated.
```

**Fix:** Run `auggie status` to diagnose. Start the Augment daemon:
```bash
auggie start
```

### Skill not found

```
[System]: Skill "myskill" not found in workspace or home skills directories.
```

**Fix:** Check that the skill file exists at `.pi/skills/myskill/SKILL.md`.

### Q&A triggered

```
[System]: Missing context for skill. Which files should I focus on?
```

**Fix:** The Judge couldn't determine the scope. Provide a clarification:
```
/src/utils/auth.ts and src/middleware/auth.ts
```

The router will re-run with this clarification appended to the brief.

### Sub-agent timeout

```
[System]: Sub-agent stopped early (timeout).
```

**Fix:** Increase `totalTimeoutMs` in settings, or provide more specific input to reduce work.

### Model not allowed

```
[System]: Sub-agent failed: Model "evil/model" uses a disallowed provider.
```

**Fix:** Configure `allowedProviderPrefixes` in settings:
```json
{
  "auggieRouter": {
    "allowedProviderPrefixes": ["openrouter", "anthropic"]
  }
}
```

## Next Steps

- **Enable adaptive routing** — see [README.md](README.md#adaptive-execution-model-routing)
- **Add custom middleware** — intercept or rewrite tool results
- **Extend with MCP servers** — bring your own tools and data sources
- **Review security considerations** — see [README.md](README.md#security-model)

## Example: Full Workflow with Adaptive Routing

1. Enable routing in `.pi/settings.json`:
   ```json
   {
     "auggieRouter": {
       "executionRouting": {
         "enabled": true,
         "preference": "preferCheap",
         "surfaceDecision": true
       }
     }
   }
   ```

2. Create a simple documentation skill without `model:`:
   ```markdown
   # .pi/skills/docs/SKILL.md
   Generate API documentation for the code provided.
   Use Markdown with JSDoc-style parameter documentation.
   ```

3. Run it:
   ```
   /skill:docs Document src/api/routes.ts
   ```

4. Observe the routing decision:
   ```
   [System]: ⚙️ Executing /skill:docs using cheap model openrouter/anthropic/claude-3-5-haiku. Reason: route cheap (complexity=low, risk=read_only, confidence=0.95)
   ```

The router classified this as a read-only, low-complexity task and selected the cheap model, saving cost while maintaining quality.
