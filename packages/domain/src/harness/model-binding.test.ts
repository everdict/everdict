import type { ModelSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { modelApiKeySecretName, modelConnectionEnv, normalizeModelBinding } from "./model-binding.js";

const openai: ModelSpec = {
  id: "gpt-5.4-mini",
  version: "1.0.0",
  provider: "openai",
  model: "gpt-5.4-mini",
  baseUrl: "https://litellm.internal/v1",
  tags: [],
};
const anthropic: ModelSpec = {
  id: "opus",
  version: "1.0.0",
  provider: "anthropic",
  model: "claude-opus-4-8",
  tags: [],
};

describe("normalizeModelBinding", () => {
  it("treats a bare string as the model id at latest with no override", () => {
    expect(normalizeModelBinding("gpt-5.4-mini")).toEqual({ ref: "gpt-5.4-mini", version: "latest" });
  });

  it("passes through a ModelRef's ref, pinned version, and env override", () => {
    expect(normalizeModelBinding({ ref: "gpt-5.4-mini", version: "2.0.0", env: { apiKey: "LLM_KEY" } })).toEqual({
      ref: "gpt-5.4-mini",
      version: "2.0.0",
      env: { apiKey: "LLM_KEY" },
    });
  });

  it("defaults an unpinned ModelRef to latest and omits an absent override", () => {
    expect(normalizeModelBinding({ ref: "opus" })).toEqual({ ref: "opus", version: "latest" });
  });
});

describe("modelApiKeySecretName", () => {
  it("uses the explicit apiKeySecret when set", () => {
    expect(modelApiKeySecretName({ ...openai, apiKeySecret: "MY_LITELLM_KEY" })).toBe("MY_LITELLM_KEY");
  });

  it("falls back to the provider default", () => {
    expect(modelApiKeySecretName(openai)).toBe("OPENAI_API_KEY");
    expect(modelApiKeySecretName(anthropic)).toBe("ANTHROPIC_API_KEY");
  });
});

describe("modelConnectionEnv", () => {
  it("injects provider-standard names for openai (key + baseUrl + model)", () => {
    expect(modelConnectionEnv(openai, "sk-abc")).toEqual({
      OPENAI_MODEL: "gpt-5.4-mini",
      OPENAI_BASE_URL: "https://litellm.internal/v1",
      OPENAI_API_KEY: "sk-abc",
    });
  });

  it("injects provider-standard names for anthropic and omits baseUrl when the model declares none", () => {
    expect(modelConnectionEnv(anthropic, "sk-ant")).toEqual({
      ANTHROPIC_MODEL: "claude-opus-4-8",
      ANTHROPIC_API_KEY: "sk-ant",
    });
  });

  it("omits the API key var when no key value resolved (own-pays / server-side auth)", () => {
    expect(modelConnectionEnv(openai, undefined)).toEqual({
      OPENAI_MODEL: "gpt-5.4-mini",
      OPENAI_BASE_URL: "https://litellm.internal/v1",
    });
  });

  it("honors per-binding env-name overrides (a CLI/agent server that reads different vars)", () => {
    expect(modelConnectionEnv(openai, "sk-abc", { apiKey: "LLM_KEY", baseUrl: "LLM_URL", model: "LLM_MODEL" })).toEqual(
      {
        LLM_MODEL: "gpt-5.4-mini",
        LLM_URL: "https://litellm.internal/v1",
        LLM_KEY: "sk-abc",
      },
    );
  });

  it("overrides only the named vars, leaving the rest provider-standard", () => {
    expect(modelConnectionEnv(openai, "sk-abc", { apiKey: "LLM_KEY" })).toEqual({
      OPENAI_MODEL: "gpt-5.4-mini",
      OPENAI_BASE_URL: "https://litellm.internal/v1",
      LLM_KEY: "sk-abc",
    });
  });
});
