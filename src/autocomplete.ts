import { listSkills } from "./parser.js";
import type { AutocompleteSpec, AutocompleteSuggestion, PiHost } from "./types.js";

/** Literal prefix declared to the host as the completion trigger. */
export const SKILL_TRIGGER = "/skill:";

/**
 * Suggest skill names for a partially typed `/skill:` command. Returns an
 * empty list once the name is complete (a space follows it) or when the
 * input doesn't start with the trigger.
 */
export function suggestSkills(host: PiHost, input: string): AutocompleteSuggestion[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith(SKILL_TRIGGER)) return [];
  const partial = trimmed.slice(SKILL_TRIGGER.length);
  if (/\s/.test(partial)) return [];
  return listSkills(host)
    .filter((s) => s.name.startsWith(partial))
    .map((s) => ({
      value: `${SKILL_TRIGGER}${s.name} `,
      label: s.name,
      description: s.description,
    }));
}

export function makeSkillAutocomplete(host: PiHost): AutocompleteSpec {
  return {
    trigger: SKILL_TRIGGER,
    getSuggestions: (input) => suggestSkills(host, input),
  };
}
