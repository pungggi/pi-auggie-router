/**
 * Model translation per PRD §2.2.
 *
 * Maps SKILL frontmatter `model:` strings to fully-qualified gateway IDs
 * of the form `{defaultProvider}/anthropic/{model}`.
 *
 * Idempotent: a string already containing two `/` segments (provider/vendor/model)
 * is returned untouched. A single-segment vendor-prefixed string like
 * `anthropic/claude-3-7-sonnet` only gets the provider prefix added.
 *
 * SEC-06: If `allowedProviderPrefixes` is non-empty, fully-qualified model
 * strings whose first path segment doesn't match an allowed prefix are rejected.
 */

const ANTHROPIC_PREFIX = "anthropic/";

export class DisallowedProviderError extends Error {
  constructor(
    public readonly model: string,
    public readonly allowed: string[]
  ) {
    super(
      `Model "${model}" uses a disallowed provider. ` +
        `Allowed prefixes: ${allowed.join(", ")}`
    );
    this.name = "DisallowedProviderError";
  }
}

export function mapModel(
  rawModel: string | undefined,
  defaultProvider: string,
  allowedProviderPrefixes: string[] = []
): string {
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
    if (allowedProviderPrefixes.length > 0) {
      const modelProvider = m.split("/")[0]!;
      if (!allowedProviderPrefixes.includes(modelProvider)) {
        throw new DisallowedProviderError(m, allowedProviderPrefixes);
      }
    }
    return m;
  }

  // vendor/model — only prefix the provider.
  if (m.includes("/")) {
    return `${provider}/${m}`;
  }

  // Bare model — assume Anthropic per PRD example.
  return `${provider}/${ANTHROPIC_PREFIX}${m}`;
}
