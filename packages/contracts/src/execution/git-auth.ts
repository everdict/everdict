// How a resolved git credential is presented to git — ONE authority, because the rule that matters is a
// security rule: the token goes into `http.extraheader` through the environment (git 2.31+ `GIT_CONFIG_*`),
// never into argv and never into `.git/config`. argv is world-readable through `ps`; `.git/config` outlives
// the command and would travel inside a world snapshot. Both consumers (the eval lane's RepoEnvironment and
// the session lane's clone/push) build the env here so the rule cannot drift between them.
//
// ⚠️ AND THE KEY IS SCOPED, BECAUSE A BARE ONE IS SENT TO EVERY HOST. `http.extraheader` with no URL applies
// to EVERY HTTP(S) request the git process makes. A clone whose tree carries a `.gitmodules` pointing
// elsewhere, or a host answering with a cross-host 30x, therefore received
// `Authorization: Bearer <installation-token>` — a live GitHub App token for the workspace's selected
// repositories, handed to a host the workspace never named. The scoped form `http.<url>.extraheader` is
// applied by git only to URLs under that prefix. Found by `pnpm scan` over files nobody had touched.

/**
 * The URL prefix git matches this credential against: scheme, host, port and repository path, with the
 * caller's credentials, query and fragment dropped and a trailing `.git` normalised away so the same
 * repository written either way produces one scope.
 *
 * Returns undefined when the remote is not an HTTP(S) URL. The token IS an HTTP credential, so there is
 * nothing to scope it to — and attaching it anyway is precisely what left a bare key in the environment.
 */
function httpCredentialScope(remoteUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\.git$/, "")}`;
}

/**
 * @param token the resolved credential
 * @param remoteUrl the remote this credential was issued for — required, because a credential with no
 *   destination cannot be scoped, and an unscoped one is broadcast
 */
export function gitAuthEnv(token: string, remoteUrl: string): Record<string, string> {
  // Suppressing the prompt is not about the credential: without it git blocks on a terminal that is not
  // there when authentication is missing, so it is set on every path.
  const base = { GIT_TERMINAL_PROMPT: "0" };
  const scope = httpCredentialScope(remoteUrl);
  // No scope, no header. The clone then fails as an ordinary authentication failure — visible, local, and
  // not a secret sent to a host nobody named.
  if (scope === undefined) return base;
  return {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${scope}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
}

// The committer a machine-made commit carries when the caller named nobody. A session's commits are the
// workspace's, not a member's personal identity — the run record already says who was at the shell.
export const GIT_MACHINE_IDENTITY = { name: "everdict", email: "everdict@local" } as const;
