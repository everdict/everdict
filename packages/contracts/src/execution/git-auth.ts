// How a resolved git credential is presented to git — ONE authority, because the rule that matters is a
// security rule: the token goes into `http.extraheader` through the environment (git 2.31+ `GIT_CONFIG_*`),
// never into argv and never into `.git/config`. argv is world-readable through `ps`; `.git/config` outlives
// the command and would travel inside a world snapshot. Both consumers (the eval lane's RepoEnvironment and
// the session lane's clone/push) build the env here so the rule cannot drift between them.
//
// ⚠️ AND THE KEY IS SCOPED, BECAUSE A BARE ONE IS SENT TO EVERY HOST. `http.extraheader` with no URL applies
// to EVERY HTTP(S) request the git process makes. A clone whose tree carries a `.gitmodules` pointing
// elsewhere, or a host answering with a cross-host 30x, therefore received
// the Authorization header carrying a live GitHub App installation token for the workspace's selected
// repositories, handed to a host the workspace never named. The scoped form `http.<url>.extraheader` is
// applied by git only to URLs under that prefix. Found by `pnpm scan` over files nobody had touched.

/**
 * The URL prefix git matches this credential against: scheme, host, port and repository path, with the
 * caller's credentials, query and fragment dropped.
 *
 * ⚠️ THE TRAILING `.git` IS KEPT, and removing it is what made every private clone fail. `git config
 * --get-urlmatch` compares the config's URL against the remote as GIVEN; it does not normalise a `.git`
 * suffix on either side. So a scope written `…/digo-mobile` never matched a clone of
 * `…/digo-mobile.git` — the config section was stored exactly as intended, git simply considered it a
 * different URL and fell through to asking for a username. Measured in a live container: same token, same
 * Basic header, `--get-urlmatch` found the entry for the URL without the suffix and not for the one with it.
 *
 * Normalising was a reasonable instinct — one repository, one scope — but the thing on the other side of
 * this string is git's matcher, not ours, and it does not share the instinct.
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
  return `${url.protocol}//${url.host}${url.pathname}`;
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
    // ⚠️ BASIC, NOT BEARER — GitHub's git smart-HTTP endpoint refuses an installation token presented as a
    // bearer credential, while its REST API accepts exactly that. So every isolated check passed (the App
    // owns the installation, the mint returns 201 scoped to the repo, the branch is reachable with that very
    // token) and the clone still answered `fatal: could not read Username` — git's message for "no usable
    // credential", which names nothing about why. Measured in a live sandbox, same token, same scope, one
    // header word apart: `Basic` cloned, `Bearer` did not.
    //
    // The username half is a constant GitHub documents for this: any non-empty user with the token as the
    // password. `x-access-token` is the one it names.
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${base64(`x-access-token:${token}`)}`,
  };
}

// Base64 for the Basic credential. `btoa` is present in every runtime this package targets (Node 18+ and the
// browser) and takes latin-1 — which is all a token and this fixed username are.
function base64(value: string): string {
  return btoa(value);
}

// The committer a machine-made commit carries when the caller named nobody. A session's commits are the
// workspace's, not a member's personal identity — the run record already says who was at the shell.
export const GIT_MACHINE_IDENTITY = { name: "everdict", email: "everdict@local" } as const;
