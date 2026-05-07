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

const VALID_SKILL_NAME = /^[a-zA-Z0-9_-]+$/;

export default function auggieRouterExtension(pi: ExtensionAPI): void {
  const host = createExtensionBridge(pi);
  const router = createRouter(host);

  pi.registerCommand("skill", {
    description: "Execute a skill via the auggie router. Usage: /skill <name>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /skill <name>", "error");
        return;
      }
      if (!VALID_SKILL_NAME.test(name)) {
        ctx.ui.notify(
          `Invalid skill name "${name}". Use only letters, digits, hyphens, underscores.`,
          "error",
        );
        return;
      }
      await router.trigger(`/skill:${name}`);
    },
  });
}
