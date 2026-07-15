import { z } from "zod";

// Model — a first-class model definition a tenant registers ("what to infer/judge with"). Registration/version/tenant
// ownership follow the same immutable-version SSOT pattern as harness/judge/runtime. judge·harness reference a registered
// model by id instead of a raw string → provider/baseUrl/underlying model + API key resolved at run time. "Which model did it
// run on" becomes a first-class, comparable dimension of the eval result — and a harness's agent server gets its whole
// connection (baseUrl + model + key) from one reference instead of a hand-assembled raw env combination.
// ⚠️ Still NO plaintext secret here — apiKeySecret names a tenant SecretStore key; the VALUE is resolved just before dispatch
// (same discipline as EnvValue {secretRef} / runtime authSecret). Only non-secret connection info + that reference are stored:
// provider, model (underlying identifier), baseUrl (OpenAI-compatible proxy=LiteLLM etc., optional), apiKeySecret (secret NAME,
// optional — unset falls back to the provider default ANTHROPIC_API_KEY/OPENAI_API_KEY), params (sampling defaults).
export const ModelSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  model: z.string(), // underlying model identifier (e.g. "claude-opus-4-8", "gpt-5.4-mini")
  baseUrl: z.string().url().optional(), // OpenAI/Anthropic-compatible proxy base (LiteLLM etc.). Non-secret.
  apiKeySecret: z.string().optional(), // NAME of a workspace SecretStore key holding this model's API key (never the value). Unset → provider default.
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

// A harness's reference to a registered Model — the channel that replaces a raw env combination (OPENAI_BASE_URL +
// OPENAI_API_KEY + MODEL hand-wired in env). At dispatch the control plane resolves ref → ModelSpec, reads its
// apiKeySecret value from SecretStore, and injects the connection into the agent server's env. env = optional
// per-binding override of the target env-var NAMES (hybrid): unset → provider-standard names (OPENAI_*/ANTHROPIC_*),
// set → those exact names for the CLI/agent server that expects different ones. Values (key/baseUrl/model) always come
// from the resolved model + secret, never here.
export const ModelRefSchema = z
  .object({
    ref: z.string(), // registered Model id (owner-first + _shared; version unless pinned = latest)
    version: z.string().optional(),
    env: z
      .object({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ModelRef = z.infer<typeof ModelRefSchema>;

// A model binding on a harness: a bare id string (shorthand — provider-standard env names) or an explicit ModelRef.
// A string keeps the command harness's {{model}} slot behavior (an unregistered string stays a literal); an object always
// means "resolve this registered model and inject its connection env".
export const ModelBindingSchema = z.union([z.string(), ModelRefSchema]);
export type ModelBinding = z.infer<typeof ModelBindingSchema>;
