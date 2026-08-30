import type { WorkspaceCiLink } from "@everdict/contracts";

// ── WHICH LINK, IF ANY, TRUSTS THIS TOKEN (arch-review 122) ──────────────────────────────────────────
//
// This used to be an inline closure in the composition root, deciding on `host` + `repository` while the
// token's `ref`, `sha`, `workflow` and `eventName` were parsed and consulted by nothing. Two problems, and
// the second is why it moved here rather than merely gaining a clause:
//
//   · the policy could not express "only from the default branch", and `ci` carries `harnesses:register`
//     (the merge-time re-pin) plus `scorecards:run` — so branch-push access was register-and-spend access;
//   · a decision living in a composition root is a decision no test can drive, which is how it stayed
//     unexamined. A pure function over the links and the claims is the same rule, and it has a suite.
//
// ABSENT `refs` = any ref, which is what every link written before the field meant. That is the permissive
// arm, so it is a stated default rather than a silent one (rule `protocol`: a policy whose arms differ in
// what they lose is selected explicitly, and a permissive default is disclosed where an operator reads it).
export interface CiTokenClaims {
  repository: string;
  host?: string;
  ref?: string;
}

const normHost = (host: string | undefined): string => (host ?? "").replace(/\/$/, "").toLowerCase();

// ── ONE WILDCARD, BECAUSE THE DOMAIN HAS AN IRREDUCIBLE ONE (arch-review 122) ───────────────────────
//
// The first version took exact values only, reasoning that "a pattern language is a second thing to get
// wrong". Reading what the generated workflow actually fires on showed that exact values cannot express the
// set it produces:
//
//     pull_request    ref = refs/pull/<n>/merge   ← a different value per pull request
//     issue_comment   ref = refs/heads/<default>
//     push            ref = refs/heads/<default>
//
// So a link pinned to `refs/heads/main` would have authenticated the merge lane and REFUSED every PR
// evaluation — a pin that silently breaks the feature it protects is worse than no pin, because the operator
// who set it believes they are covered. A trailing `*` is a prefix match and is the only wildcard: it
// expresses `refs/pull/*` and nothing else needs expressing. `refs/pull/*` does not match `refs/pullX`,
// because the prefix keeps its slash.
function refAllowed(patterns: readonly string[], ref: string | undefined): boolean {
  if (patterns.length === 0) return true;
  if (ref === undefined) return false; // silence is not the trusted branch
  return patterns.some((p) => (p.endsWith("*") ? ref.startsWith(p.slice(0, -1)) : p === ref));
}

// A link trusts a token when the host and repository match AND, when the link names refs, the token carries
// one of them. A token with NO ref cannot satisfy a link that names refs: silence is not the trusted branch.
export function ciLinkTrusting(links: readonly WorkspaceCiLink[], claims: CiTokenClaims): WorkspaceCiLink | undefined {
  return links.find(
    (link) =>
      !link.disabled &&
      normHost(link.host) === normHost(claims.host) &&
      link.repository.toLowerCase() === claims.repository.toLowerCase() &&
      refAllowed(link.refs ?? [], claims.ref),
  );
}
