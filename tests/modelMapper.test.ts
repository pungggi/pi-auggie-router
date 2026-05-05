import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapModel, DisallowedProviderError } from "../src/modelMapper.ts";

describe("mapModel", () => {
  it("prefixes a bare model name with provider/anthropic/", () => {
    assert.equal(
      mapModel("claude-3-7-sonnet", "openrouter"),
      "openrouter/anthropic/claude-3-7-sonnet"
    );
  });

  it("only prefixes the provider when vendor/model is supplied", () => {
    assert.equal(
      mapModel("anthropic/claude-3-5-haiku", "openrouter"),
      "openrouter/anthropic/claude-3-5-haiku"
    );
  });

  it("is idempotent for already fully-qualified IDs", () => {
    assert.equal(
      mapModel("openrouter/anthropic/claude-3-5-sonnet", "openrouter"),
      "openrouter/anthropic/claude-3-5-sonnet"
    );
  });

  it("returns the configured fallback when model is missing", () => {
    assert.equal(mapModel(undefined, "openrouter"), "openrouter/anthropic/claude-3-5-sonnet");
    assert.equal(mapModel("   ", "openrouter"), "openrouter/anthropic/claude-3-5-sonnet");
  });

  it("strips trailing slashes from the provider", () => {
    assert.equal(
      mapModel("claude-3-7-sonnet", "openrouter/"),
      "openrouter/anthropic/claude-3-7-sonnet"
    );
  });

  it("throws when defaultProvider is empty", () => {
    assert.throws(() => mapModel("claude-3-7-sonnet", ""));
  });

  it("allows fully-qualified models when allowlist is empty", () => {
    assert.equal(
      mapModel("evil/vendor/model", "openrouter", []),
      "evil/vendor/model"
    );
  });

  it("allows fully-qualified models matching an allowlist entry", () => {
    assert.equal(
      mapModel("openrouter/anthropic/claude-3-5-sonnet", "openrouter", ["openrouter"]),
      "openrouter/anthropic/claude-3-5-sonnet"
    );
  });

  it("rejects fully-qualified models not in allowlist", () => {
    assert.throws(
      () => mapModel("evil/vendor/model", "openrouter", ["openrouter"]),
      DisallowedProviderError
    );
  });

  it("enforces allowlist on defaultProvider-prefixed vendor and bare models", () => {
    assert.throws(
      () => mapModel("anthropic/claude-3-5-haiku", "evil", ["openrouter"]),
      DisallowedProviderError
    );
    assert.throws(
      () => mapModel("claude-3-5-haiku", "evil", ["openrouter"]),
      DisallowedProviderError
    );
  });

  it("enforces allowlist on fallback defaultProvider", () => {
    assert.throws(
      () => mapModel(undefined, "evil", ["openrouter"]),
      DisallowedProviderError
    );
  });
});
