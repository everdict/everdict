import { BadRequestError, type RunContext } from "@everdict/contracts";

// Harness model auth + endpoint env. collectAuthEnv forwards every one that is present.
// - claude vars (confirmed against the claude binary): the effective precedence (subscription token → auth token →
//   API key) is enforced by the claude binary itself, not here.
// - OpenAI-compatible vars: an agent-under-test that is NOT claude (aider/codex/a custom OpenAI-SDK agent) reaches its
//   model through OPENAI_API_KEY + OPENAI_BASE_URL; forward both (plus ANTHROPIC_BASE_URL for a gateway-fronted claude)
//   so the control plane's injected job env actually reaches the harness subprocess. Without the base URL, an
//   OpenAI-based agent gets a key but points at the default api.openai.com — the exact "key but no endpoint" gap.
const AUTH_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

// Collect only the harness model auth/endpoint vars that are present in the current process env.
// LocalDriver/local backend: these (usually empty) → claude uses the machine login.
// Nomad backend: inject these into the job (alloc), since the sandbox has no login.
export function collectAuthEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of AUTH_VARS) {
    const val = process.env[v];
    if (val) out[v] = val;
  }
  return out;
}

// Boundary parse of the run timeout. Precedence: the EVERDICT_TIMEOUT_SEC env var (operator override) wins; absent →
// the per-case fallback (EvalCase.timeoutSec, plumbed by the dispatched agent); absent there too → 300s. A present-
// but-invalid env value (non-numeric, non-integer, zero, negative) → throw, never a silent NaN (a NaN timeout would
// silently break every downstream comparison) — fail-fast surfaces a misconfigured EVERDICT_TIMEOUT_SEC as a
// classified (config) failure. The fallback is already schema-validated (EvalCase.timeoutSec is int+positive).
function timeoutSecFromEnv(raw: string | undefined, fallbackSec: number): number {
  if (raw === undefined) return fallbackSec;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { EVERDICT_TIMEOUT_SEC: raw },
      "EVERDICT_TIMEOUT_SEC must be a positive integer (seconds).",
    );
  return n;
}

// caseTimeoutSec = the per-case timeout (EvalCase.timeoutSec) the dispatched agent passes so a long agent case (a real
// ReAct loop = many sequential LLM calls) is not silently killed at the old hardcoded 5 min. Env var still overrides.
export function runContextFromEnv(caseTimeoutSec?: number): RunContext {
  return {
    apiKeyEnv: collectAuthEnv(),
    timeoutSec: timeoutSecFromEnv(process.env.EVERDICT_TIMEOUT_SEC, caseTimeoutSec ?? 300),
  };
}

export function hasClaudeAuth(): boolean {
  return Object.keys(collectAuthEnv()).length > 0;
}
