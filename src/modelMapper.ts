/**
 * Model translation per PRD §2.2.
 *
 * Maps SKILL frontmatter `model:` strings to fully-qualified gateway IDs
 * of the form `{defaultProvider}/anthropic/{model}`.
 *
 * Idempotent: a string already containing two `/` segments (provider/vendor/model)
 * is returned untouched. A single-segment vendor-prefixed string like
 * `anthropic/claude-3-7-sonnet` only gets the provider prefix added.
 */

const ANTHROPIC_PREFIX = "anthropic/";

export function mapModel(rawModel: string | undefined, defaultProvider: string): string {
  const provider = defaultProvider.trim().replace(/\/+$/, "");
  if (!provider) {
    throw new Error("mapModel: defaultProvider is empty");
  }

  const fallback = `${provider}/anthropic/claude-3-5-sonnet`;
  if (!rawModel || !rawModel.trim()) {
    return fallback;
  }

  const m = rawModel.trim();

  // Already fully qualified (provider/vendor/model).
  if (m.split("/").length >= 3) {
    return m;
  }

  // vendor/model — only prefix the provider.
  if (m.includes("/")) {
    return `${provider}/${m}`;
  }

  // Bare model — assume Anthropic per PRD example.
  return `${provider}/${ANTHROPIC_PREFIX}${m}`;
}
