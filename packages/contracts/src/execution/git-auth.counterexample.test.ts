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
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/acme/widgets.git.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${btoa("x-access-token:ghs_secret")}`);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  });

  // ⚠️ THIS ASSERTION USED TO REQUIRE THE OPPOSITE, and requiring it is what made every private clone fail.
  // "One repository, one scope" is a reasonable instinct and git does not share it: `--get-urlmatch` compares
  // the config's URL against the remote AS GIVEN, with no `.git` normalisation on either side. A scope written
  // `…/widgets` therefore never matched a clone of `…/widgets.git`, git fell through to asking for a username,
  // and the failure surfaced as `fatal: could not read Username` — which names neither the scope nor the URL.
  //
  // Measured in a live container: with the entry stored under `…/digo-mobile`, `--get-urlmatch` found it for
  // the URL without the suffix and NOT for the one with it, while a host-only scope and a bare key both cloned.
  // The scope must be the remote the clone will use, character for character.
  it("scopes to the remote AS WRITTEN, because git does not normalise a .git suffix", () => {
    expect(gitAuthEnv("t", "https://github.com/acme/widgets.git").GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/acme/widgets.git.extraheader",
    );
    expect(gitAuthEnv("t", "https://github.com/acme/widgets").GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/acme/widgets.extraheader",
    );
  });

  it("keeps a port in the scope, because a different port is a different service", () => {
    const env = gitAuthEnv("t", "https://ghe.internal:8443/acme/widgets.git");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://ghe.internal:8443/acme/widgets.git.extraheader");
  });

  it("drops credentials, query and fragment from the scope rather than leaking them into config", () => {
    const env = gitAuthEnv("t", "https://user:pw@github.com/acme/widgets.git?ref=main#frag");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/acme/widgets.git.extraheader");
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

  // ── AND THE SCHEME IS BASIC, BECAUSE GIT'S ENDPOINT IS NOT THE REST API ────────────────────────────
  //
  // This assertion used to read `Authorization: Bearer ghs_secret`, and it PASSED while every private clone
  // in the product failed. GitHub's REST API accepts an installation token as a bearer credential; its git
  // smart-HTTP endpoint does not. So each link verified on its own — the App owned the installation, the mint
  // returned 201 scoped to the repository, the branch was reachable with that very token — and git answered
  // `fatal: could not read Username for 'https://github.com'`, which is its message for "no usable
  // credential" and names nothing about why.
  //
  // Measured in a live sandbox, same token, same scope, one word apart: `Basic` cloned, `Bearer` did not.
  // The test was pinning the wrong half of the contract, which is why it protected the defect instead of
  // catching it — a shape worth remembering: an assertion copied from the code cannot disagree with it.
  it("presents the token as Basic with the username GitHub documents, not as a bearer", () => {
    const env = gitAuthEnv("ghs_secret", "https://github.com/acme/widgets.git");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("Bearer");
    const [scheme, encoded] = (env.GIT_CONFIG_VALUE_0 ?? "").replace("Authorization: ", "").split(" ");
    expect(scheme).toBe("Basic");
    expect(atob(encoded ?? "")).toBe("x-access-token:ghs_secret");
  });

  // The value is the credential, so it may not be readable at a glance in a process listing or a log line.
  it("does not carry the token in the clear", () => {
    const env = gitAuthEnv("ghs_secret", "https://github.com/acme/widgets.git");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("ghs_secret");
  });
});
