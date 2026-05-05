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
 * SEC-06: If `allowedProviderPrefixes` is non-empty, every resolved model's
 * provider prefix must match an allowed prefix. This includes fallback and
 * defaultProvider-prefixed vendor/bare model inputs, not only already fully
 * qualified raw model strings.
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

function assertAllowedProvider(
  resolvedModel: string,
  allowedProviderPrefixes: string[]
): string {
  if (allowedProviderPrefixes.length === 0) return resolvedModel;
  const modelProvider = resolvedModel.split("/")[0]!;
  if (!allowedProviderPrefixes.includes(modelProvider)) {
    throw new DisallowedProviderError(resolvedModel, allowedProviderPrefixes);
  }
  return resolvedModel;
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
    return assertAllowedProvider(fallback, allowedProviderPrefixes);
  }

  const m = rawModel.trim();

  // Already fully qualified (provider/vendor/model).
  if (m.split("/").length >= 3) {
    return assertAllowedProvider(m, allowedProviderPrefixes);
  }

  // vendor/model — only prefix the provider.
  if (m.includes("/")) {
    return assertAllowedProvider(`${provider}/${m}`, allowedProviderPrefixes);
  }

  // Bare model — assume Anthropic per PRD example.
  return assertAllowedProvider(`${provider}/${ANTHROPIC_PREFIX}${m}`, allowedProviderPrefixes);
}
