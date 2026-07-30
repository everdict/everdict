import { BadRequestError, HARNESS_AUTH_ENV_VARS, type RunContext } from "@everdict/contracts";

// Collect only the harness model auth/endpoint vars that are present in the current process env.
// The vocabulary itself lives in @everdict/contracts (auth-env.ts) so the control plane's driver-lane
// sessions pick the same names from tenant secrets.
// LocalDriver/local backend: these (usually empty) → claude uses the machine login.
// Nomad backend: inject these into the job (alloc), since the sandbox has no login.
export function collectAuthEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of HARNESS_AUTH_ENV_VARS) {
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
