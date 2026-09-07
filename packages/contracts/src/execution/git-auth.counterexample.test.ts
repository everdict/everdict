import { describe, expect, it } from "vitest";
import { gitAuthEnv } from "./git-auth.js";

// ── A CREDENTIAL SCOPED TO NOTHING IS SENT TO EVERYONE ───────────────────────────────────────────
//
// `gitAuthEnv` presents a GitHub App installation token to git through `http.extraheader`, which is the
// right transport: the environment rather than argv (world-readable through `ps`) and rather than
// `.git/config` (outlives the command, travels in a world snapshot). Both of those arguments are in the
// file's own header and both hold.
//
// The KEY was bare:
//
//     GIT_CONFIG_KEY_0: "http.extraheader"
//
// Git applies a bare `http.extraheader` to EVERY HTTP(S) request the process makes — not to the repository
// host. A clone whose tree carries a `.gitmodules` pointing elsewhere, or a host that answers with a
// cross-host 30x, therefore sends `Authorization: Bearer <installation-token>` to that other host. The
// scoped form is `http.<url>.extraheader`, which git applies only to URLs under that prefix.
//
// Found by `pnpm scan` over `packages/contracts/src` — 291 files nobody had touched.

describe("a git credential is scoped to the repository it was issued for", () => {
  it("scopes the header to the remote, never bare", () => {
    const env = gitAuthEnv("ghs_secret", "https://github.com/acme/widgets.git");
    // The bare key is the defect. Its presence means every host this process dials gets the token.
    expect(env.GIT_CONFIG_KEY_0).not.toBe("http.extraheader");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/acme/widgets.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer ghs_secret");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  });

  it("scopes to the same repository whether or not the caller wrote .git", () => {
    const withSuffix = gitAuthEnv("t", "https://github.com/acme/widgets.git");
    const without = gitAuthEnv("t", "https://github.com/acme/widgets");
    expect(withSuffix.GIT_CONFIG_KEY_0).toBe(without.GIT_CONFIG_KEY_0);
  });

  it("keeps a port in the scope, because a different port is a different service", () => {
    const env = gitAuthEnv("t", "https://ghe.internal:8443/acme/widgets.git");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://ghe.internal:8443/acme/widgets.extraheader");
  });

  it("drops credentials, query and fragment from the scope rather than leaking them into config", () => {
    const env = gitAuthEnv("t", "https://user:pw@github.com/acme/widgets.git?ref=main#frag");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/acme/widgets.extraheader");
    expect(JSON.stringify(env)).not.toContain("pw");
  });

  // The token is an HTTP credential. On a transport that cannot carry it, attaching it anyway is what put a
  // bare key in the environment in the first place — so it is not attached, and the clone fails as an
  // ordinary auth failure rather than succeeding while broadcasting a secret.
  it("attaches no header at all when the remote is not http(s)", () => {
    for (const remote of ["git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets.git", "not a url"]) {
      const env = gitAuthEnv("ghs_secret", remote);
      expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("ghs_secret");
      // The prompt suppression is not about the credential and stays either way.
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });
});
