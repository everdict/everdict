import { BadRequestError, type RunContext } from "@everdict/contracts";

// claude auth env vars (confirmed against the claude binary). collectAuthEnv forwards every one that is present; the
// effective precedence (subscription token → auth token → API key) is enforced by the claude binary itself, not here.
const AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

// Collect only the claude auth vars that are present in the current process env.
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

// Boundary parse of the run timeout: absent → default 300s; present-but-invalid (non-numeric, non-integer, zero,
// negative) → throw, never a silent NaN. A NaN timeout would silently break every downstream comparison; fail-fast
// surfaces a misconfigured EVERDICT_TIMEOUT_SEC at the boundary as a classified (config) failure.
function timeoutSecFromEnv(raw: string | undefined): number {
  if (raw === undefined) return 300;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { EVERDICT_TIMEOUT_SEC: raw },
      "EVERDICT_TIMEOUT_SEC must be a positive integer (seconds).",
    );
  return n;
}

export function runContextFromEnv(): RunContext {
  return {
    apiKeyEnv: collectAuthEnv(),
    timeoutSec: timeoutSecFromEnv(process.env.EVERDICT_TIMEOUT_SEC),
  };
}

export function hasClaudeAuth(): boolean {
  return Object.keys(collectAuthEnv()).length > 0;
}
