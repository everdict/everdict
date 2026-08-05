// How a resolved git credential is presented to git — ONE authority, because the rule that matters is a
// security rule: the token goes into `http.extraheader` through the environment (git 2.31+ `GIT_CONFIG_*`),
// never into argv and never into `.git/config`. argv is world-readable through `ps`; `.git/config` outlives
// the command and would travel inside a world snapshot. Both consumers (the eval lane's RepoEnvironment and
// the session lane's clone/push) build the env here so the rule cannot drift between them.
export function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_TERMINAL_PROMPT: "0", // don't wait at a prompt on missing credentials (fail immediately)
  };
}

// The committer a machine-made commit carries when the caller named nobody. A session's commits are the
// workspace's, not a member's personal identity — the run record already says who was at the shell.
export const GIT_MACHINE_IDENTITY = { name: "everdict", email: "everdict@local" } as const;
