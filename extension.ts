/**
 * Extension entry for pi.dev (`@earendil-works/pi-coding-agent`).
 *
 * Usage (path relative to project root where `pi` is invoked):
 *   pi -e ./node_modules/pi-auggie-router/extension.ts
 *
 * Or symlink into `.pi/extensions/` for auto-load.
 *
 * The `.js` import is resolved to `.ts` by Pi's tsx loader at runtime —
 * same convention used by every Pi extension.
 */
import { createRouter, createExtensionBridge } from "./dist/index.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  type SelectItem,
  SelectList,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";

const VALID_SKILL_NAME = /^[a-zA-Z0-9_-]+$/;

export default function auggieRouterExtension(pi: ExtensionAPI): void {
  const host = createExtensionBridge(pi);
  const router = createRouter(host);

  // ── Skill discovery ─────────────────────────────────────────────────
  function getSkillCommands() {
    return pi.getCommands().filter((cmd) => cmd.source === "skill");
  }

  function buildSelectItems(): SelectItem[] {
    return getSkillCommands().map((cmd) => ({
      value: cmd.name,
      label: cmd.name,
      description: cmd.description,
    }));
  }

  function buildAutocompleteItems(): AutocompleteItem[] {
    return getSkillCommands().map((cmd) => ({
      value: cmd.name,
      label: cmd.name,
      description: cmd.description,
    }));
  }

  // ── Interactive picker UI ────────────────────────────────────────────
  async function showSkillPicker(ctx: ExtensionCommandContext): Promise<void> {
    const items = buildSelectItems();

    if (items.length === 0) {
      ctx.ui.notify(
        "No skills available. Add skills to ~/.pi/agent/skills/ or .pi/skills/",
        "warning",
      );
      return;
    }

    const result = await ctx.ui.custom<string | null>(
      (tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select a Skill")), 1, 0));

        const selectList = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });

        selectList.onSelect = (item: SelectItem) => done(item.value);
        selectList.onCancel = () => done(null);

        container.addChild(selectList);
        container.addChild(
          new Text(
            theme.fg("dim", "↑↓ navigate · type to filter · enter select · esc cancel"),
            1,
            0,
          ),
        );
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );

    if (result) {
      ctx.ui.setEditorText(`/${result} `);
    }
  }

  // ── /skill command ──────────────────────────────────────────────────
  pi.registerCommand("skill", {
    description: "Pick and activate a skill",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const items = buildAutocompleteItems();
      const filtered = items.filter((item) =>
        item.value.toLowerCase().includes(prefix.toLowerCase()),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args?.trim();

      // ── Named skill: `/skill refactor` or `/skill refactor src/foo.ts` ──
      if (trimmed) {
        // Check if first token matches a known skill
        const tokens = trimmed.split(/\s+/);
        const first = tokens[0]!;

        // Direct skill name (without "skill:" prefix)
        if (VALID_SKILL_NAME.test(first)) {
          await router.trigger(`/skill:${first}`);
          return;
        }

        // Autocomplete selection already includes "skill:" prefix
        const skillCmd = getSkillCommands().find((cmd) => cmd.name === first);
        if (skillCmd) {
          const remainder = tokens.slice(1).join(" ");
          ctx.ui.setEditorText(`/${skillCmd.name}${remainder ? " " + remainder : ""} `);
          return;
        }

        ctx.ui.notify(
          `Invalid skill name "${first}". Use only letters, digits, hyphens, underscores.`,
          "error",
        );
        return;
      }

      // ── No args: open interactive picker ──
      await showSkillPicker(ctx);
    },
  });

  // ── Inline autocomplete for `/skill ` in the editor ─────────────────
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider(
      (current: AutocompleteProvider): AutocompleteProvider => ({
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const line = lines[cursorLine] ?? "";
          const beforeCursor = line.slice(0, cursorCol);

          const skillMatch = beforeCursor.match(/^\/skill\s+(\S*)$/);
          if (!skillMatch) {
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }

          const prefix = skillMatch[1] ?? "";
          const items = buildAutocompleteItems();
          const filtered = items.filter((item) =>
            item.value.toLowerCase().includes(prefix.toLowerCase()),
          );

          if (filtered.length === 0) {
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }

          return { items: filtered, prefix };
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },

        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      }),
    );
  });
}
