import type { WorkspaceCiLink } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ciLinkTrusting } from "./ci-trust.js";

// ── [R122 COUNTEREXAMPLE] THE REF IS PARSED AND WAS THEN THROWN AWAY ────────────────────────────────
//
// A GitHub Actions OIDC token is verified properly — signature, issuer, audience, and a `workspaceHint` that
// must match a link, all fail-closed. What the policy then decided on was only:
//
//     normHost(l.host) === normHost(claims.host) && l.repository === claims.repository
//
// while `claims.ref`, `claims.sha`, `claims.workflow` and `claims.eventName` were parsed into
// `GithubActionsClaims` and consulted by nothing. So a workspace could not say "only from the default
// branch" — the value that would express it was collected and discarded.
//
//     the token is from the linked repo   ≠   it is from a ref this workspace trusts
//
// It matters because `ci` carries `harnesses:register` — the merge-time re-pin that mints a new immutable
// harness instance version — plus `scorecards:run`. Anyone who could push a BRANCH to the linked repository
// could register a harness version and spend the workspace's evaluation budget, and push access is routinely
// wider than merge access.
//
// The policy also MOVED here, out of an inline closure in the composition root, because that is why it went
// unexamined: a decision living in a composition root is one no test can drive.
//
// Seen RED before the split: with `refs` on the link, the branch case still resolved to a trusting link.
const link = (over: Partial<WorkspaceCiLink> = {}): WorkspaceCiLink =>
  ({ repository: "acme/app", harness: "h", slots: {}, createdBy: "u", ...over }) as WorkspaceCiLink;

describe("[R122 COUNTEREXAMPLE] a CI link may pin the refs it trusts, and the pin is honoured", () => {
  it("REFUSES another branch of the linked repository when the link names refs", () => {
    const links = [link({ refs: ["refs/heads/main"] })];
    expect(
      ciLinkTrusting(links, { repository: "acme/app", ref: "refs/heads/attacker-branch" }),
      "a branch the workspace does not trust authenticated as ci",
    ).toBeUndefined();
  });

  it("accepts exactly the ref the workspace named", () => {
    const links = [link({ refs: ["refs/heads/main"] })];
    expect(ciLinkTrusting(links, { repository: "acme/app", ref: "refs/heads/main" })).toBeDefined();
  });

  it("a token carrying NO ref cannot satisfy a ref-pinned link — silence is not the trusted branch", () => {
    const links = [link({ refs: ["refs/heads/main"] })];
    expect(
      ciLinkTrusting(links, { repository: "acme/app" }),
      "a missing ref satisfied a policy that names one",
    ).toBeUndefined();
  });

  it("a link with NO refs still trusts any ref — the permissive default, asserted rather than assumed", () => {
    // Every link written before the field meant this. It is the permissive arm, so it is pinned here: if it
    // ever changes, that is a decision somebody makes on purpose and not a silent tightening.
    expect(ciLinkTrusting([link()], { repository: "acme/app", ref: "refs/heads/anything" })).toBeDefined();
    expect(ciLinkTrusting([link({ refs: [] })], { repository: "acme/app", ref: "refs/heads/x" })).toBeDefined();
  });

  it("expresses the set the generated workflow ACTUALLY produces — PR refs included", () => {
    // The workflow fires on pull_request (ref = refs/pull/<n>/merge), issue_comment and push[main]. A pin of
    // `refs/heads/main` alone would authenticate the merge lane and refuse every PR evaluation — a pin that
    // silently breaks the feature it protects. One trailing wildcard covers it.
    const links = [link({ refs: ["refs/heads/main", "refs/pull/*"] })];
    for (const ref of ["refs/heads/main", "refs/pull/7/merge", "refs/pull/1234/merge"])
      expect(ciLinkTrusting(links, { repository: "acme/app", ref }), `${ref} was refused`).toBeDefined();
    // …and the wildcard keeps its slash: it is a prefix, not a substring.
    expect(ciLinkTrusting(links, { repository: "acme/app", ref: "refs/pullX/evil" })).toBeUndefined();
    expect(ciLinkTrusting(links, { repository: "acme/app", ref: "refs/heads/other" })).toBeUndefined();
  });

  it("still refuses a disabled link and a foreign repository", () => {
    expect(ciLinkTrusting([link({ disabled: true })], { repository: "acme/app" })).toBeUndefined();
    expect(ciLinkTrusting([link()], { repository: "evil/other" })).toBeUndefined();
  });

  it("matches the host exactly — a GHE link does not trust a github.com token", () => {
    const ghe = [link({ host: "https://ghe.acme.io/" })];
    expect(ciLinkTrusting(ghe, { repository: "acme/app" })).toBeUndefined();
    expect(ciLinkTrusting(ghe, { repository: "acme/app", host: "https://ghe.acme.io" })).toBeDefined();
  });
});
