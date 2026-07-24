import type { ModelBinding, ModelRef, ModelSpec } from "@everdict/contracts";

// Model-binding semantics — how a harness's Model reference (id string | ModelRef) turns into the agent server's
// connection env. The registry/secret lookups are I/O (control plane); this file is the PURE mapping over the already
// resolved ModelSpec + secret value, the single owner of the provider-standard env vocabulary. Pairs with the
// {secretRef} rules in harness-secrets.ts.

// Provider-standard env var names — the default target for a model's connection when the binding gives no override.
// Chosen to match the judge transport + OpenAI/Anthropic SDK conventions (LiteLLM proxies read OPENAI_*). The model
// name var is a convention many agent servers read; a server expecting a different name overrides it per binding.
const PROVIDER_ENV = {
  anthropic: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL" },
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL", model: "OPENAI_MODEL" },
} as const;

// Normalize a binding to its parts. A bare string = the model id at "latest" with no env-name override.
export function normalizeModelBinding(binding: ModelBinding): { ref: string; version: string; env?: ModelRef["env"] } {
  if (typeof binding === "string") return { ref: binding, version: "latest" };
  return { ref: binding.ref, version: binding.version ?? "latest", ...(binding.env ? { env: binding.env } : {}) };
}

// The model label a binding declares (for provenance / the leaderboard model-axis fallback when the trace reports no
// observed model): the id string, or a ModelRef's ref. undefined passes through.
export function modelBindingLabel(binding: ModelBinding | undefined): string | undefined {
  if (binding === undefined) return undefined;
  return typeof binding === "string" ? binding : binding.ref;
}

// The SecretStore key name that holds this model's API key: the explicit apiKeySecret, else the provider default
// (ANTHROPIC_API_KEY / OPENAI_API_KEY — the same convention the judge transport uses).
export function modelApiKeySecretName(model: ModelSpec): string {
  return model.apiKeySecret ?? PROVIDER_ENV[model.provider].apiKey;
}

// The connection env a resolved model injects into the agent server's env: baseUrl + underlying model + API key, under
// provider-standard var names by default, overridable per binding (hybrid). apiKey = the value the caller read from the
// SecretStore (undefined → omit the key var, e.g. self-hosted own-pays or a server with its own auth). baseUrl is
// omitted when the model declares none (the SDK/proxy default applies).
export function modelConnectionEnv(
  model: ModelSpec,
  apiKey: string | undefined,
  override?: ModelRef["env"],
): Record<string, string> {
  const names = PROVIDER_ENV[model.provider];
  const env: Record<string, string> = { [override?.model ?? names.model]: model.model };
  if (model.baseUrl !== undefined) env[override?.baseUrl ?? names.baseUrl] = model.baseUrl;
  if (apiKey !== undefined) env[override?.apiKey ?? names.apiKey] = apiKey;
  return env;
}
