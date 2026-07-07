import type { RunContext } from "@everdict/core";

// claude auth env vars (confirmed against the claude binary). Precedence: subscription token → auth token → API key.
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

export function runContextFromEnv(): RunContext {
  return {
    apiKeyEnv: collectAuthEnv(),
    timeoutSec: Number(process.env.EVERDICT_TIMEOUT_SEC ?? "300"),
  };
}

export function hasClaudeAuth(): boolean {
  return Object.keys(collectAuthEnv()).length > 0;
}
