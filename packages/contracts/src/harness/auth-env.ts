// Harness model auth + endpoint env vocabulary — the variables a harness subprocess reads to reach its
// model. Shared by the job-runner (forwards the ones present in the job env) and the control plane's
// driver-lane sessions (picks the tenant's secret values by these names for a fresh container).
// - claude vars (confirmed against the claude binary): the effective precedence (subscription token →
//   auth token → API key) is enforced by the claude binary itself, not here.
// - OpenAI-compatible vars: a non-claude agent (aider/codex/a custom OpenAI-SDK agent) reaches its model
//   through OPENAI_API_KEY + OPENAI_BASE_URL; both are needed (plus ANTHROPIC_BASE_URL for a
//   gateway-fronted claude) — a key without its endpoint is the exact "key but no endpoint" gap.
// - ANTHROPIC_MODEL: the model half of the same gap — a gateway-fronted claude usually serves models under
//   the GATEWAY's aliases, so the endpoint alone leaves claude asking for a name the proxy rejects
//   (live-found: LiteLLM 400 "Invalid model name ... model=claude-*").
export const HARNESS_AUTH_ENV_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;
export type HarnessAuthEnvVar = (typeof HARNESS_AUTH_ENV_VARS)[number];
