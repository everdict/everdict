import { z } from "zod";

// Model — a first-class model definition a tenant registers ("what to infer/judge with"). Registration/version/tenant
// ownership follow the same immutable-version SSOT pattern as harness/judge/runtime. judge·harness reference a registered
// model by id instead of a raw string → provider/baseUrl/underlying model resolved at run time. "Which model did it run on"
// becomes a first-class, comparable dimension of the eval result.
// ⚠️ No secrets — API keys are injected per provider from the tenant SecretStore (ANTHROPIC_API_KEY/OPENAI_API_KEY). Only
// non-secret connection info here: provider, model (underlying identifier), baseUrl (OpenAI-compatible proxy=LiteLLM etc., optional), params (sampling defaults).
export const ModelSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  model: z.string(), // underlying model identifier (e.g. "claude-opus-4-8", "gpt-5.4-mini")
  baseUrl: z.string().url().optional(), // OpenAI/Anthropic-compatible proxy base (LiteLLM etc.). Non-secret.
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;
