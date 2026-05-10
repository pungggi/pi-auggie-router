/**
 * Skill Picker Extension
 *
 * Provides an interactive skill picker when the user types `/skill`.
 * Supports both:
 *   - `/skill`           → opens a fuzzy-searchable SelectList picker
 *   - `/skill <name>`    → directly activates a skill (e.g., `/skill assemblyai`)
 *   - `/skill <name> <args>` → activates skill with arguments
 *
 * Also adds inline autocomplete: typing `/skill ` in the editor shows
 * available skill names as autocomplete suggestions.
 *
 * Place in ~/.pi/agent/extensions/ or .pi/extensions/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Text,
	type SelectItem,
	SelectList,
	type AutocompleteItem,
	type AutocompleteProvider,
} from "@earendil-works/pi-tui";

export default function skillPickerExtension(pi: ExtensionAPI) {
	/**
	 * Get all available skill commands from pi's command registry.
	 * Skills are registered as "skill:name" commands.
	 */
	function getSkillCommands() {
		return pi.getCommands().filter((cmd) => cmd.source === "skill");
	}

	/**
	 * Extract skill name from a command entry.
	 * Commands look like "skill:brave-search" → returns "brave-search".
	 */
	function extractSkillName(commandName: string): string {
		return commandName.startsWith("skill:") ? commandName.slice(6) : commandName;
	}

	/**
	 * Build SelectItem list from available skills.
	 */
	function buildSkillItems(): SelectItem[] {
		const skills = getSkillCommands();
		return skills.map((cmd) => ({
			value: cmd.name, // e.g., "skill:brave-search"
			label: extractSkillName(cmd.name),
			description: cmd.description,
		}));
	}

	/**
	 * Build autocomplete items for inline completion.
	 */
	function buildAutocompleteItems(): AutocompleteItem[] {
		return getSkillCommands().map((cmd) => ({
			value: extractSkillName(cmd.name),
			label: extractSkillName(cmd.name),
			description: cmd.description,
		}));
	}

	/**
	 * Show the interactive skill picker as an overlay.
	 */
	async function showSkillPicker(ctx: any): Promise<void> {
		const items = buildSkillItems();

		if (items.length === 0) {
			ctx.ui.notify("No skills available. Add skills to ~/.pi/agent/skills/ or .pi/skills/", "warning");
			return;
		}

		const result = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
			const container = new Container();

			// Top border
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			// Title
			container.addChild(new Text(theme.fg("accent", theme.bold("Select a Skill")), 1, 0));

			// SelectList with fuzzy search and theme styling
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

			// Help text
			container.addChild(new Text(
				theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel"),
				1,
				0,
			));

			// Bottom border
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
		});

		if (!result) return;

		// Inject the selected skill command into the editor so the user can
		// add optional arguments, then submit
		ctx.ui.setEditorText(`/${result} `);
	}

	// ── Register /skill command ──────────────────────────────────────────
	pi.registerCommand("skill", {
		description: "Pick and activate a skill (interactive picker or /skill <name>)",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const items = buildAutocompleteItems();
			const filtered = items.filter(
				(item) =>
					item.value.startsWith(prefix) ||
					item.label.toLowerCase().includes(prefix.toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args?.trim();

			if (!trimmed) {
				// No arguments → show interactive picker
				await showSkillPicker(ctx);
				return;
			}

			// Arguments provided → find matching skill and set editor text
			const skills = getSkillCommands();
			const match = skills.find((cmd) => {
				const name = extractSkillName(cmd.name);
				return name === trimmed || cmd.name === trimmed;
			});

			if (match) {
				// Put the full command with remaining args into the editor
				const rest = args.slice(args.indexOf(trimmed) + trimmed.length).trim();
				ctx.ui.setEditorText(`/${match.name}${rest ? " " + rest : ""} `);
			} else {
				// No exact match → show picker filtered, or notify
				const available = skills.map((s) => extractSkillName(s.name)).join(", ");
				ctx.ui.notify(`Unknown skill "${trimmed}". Available: ${available}`, "warning");
			}
		},
	});

	// ── Register autocomplete provider for `/skill ` inline suggestions ──
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider(
			(current: AutocompleteProvider): AutocompleteProvider => ({
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const line = lines[cursorLine] ?? "";
					const beforeCursor = line.slice(0, cursorCol);

					// Match `/skill ` (with trailing space, indicating argument mode)
					const skillMatch = beforeCursor.match(/^\/skill\s+(\S*)$/);
					if (!skillMatch) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}

					const prefix = skillMatch[1] ?? "";
					const items = buildAutocompleteItems();
					const filtered = items.filter(
						(item) =>
							item.value.startsWith(prefix) ||
							item.value.toLowerCase().includes(prefix.toLowerCase()),
					);

					if (filtered.length === 0) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}

					return {
						items: filtered,
						prefix,
					};
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
