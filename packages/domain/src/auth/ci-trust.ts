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

// A link trusts a token when the host and repository match AND, when the link names refs, the token carries
// one of them. A token with NO ref cannot satisfy a link that names refs: silence is not the trusted branch.
export function ciLinkTrusting(links: readonly WorkspaceCiLink[], claims: CiTokenClaims): WorkspaceCiLink | undefined {
  return links.find(
    (link) =>
      !link.disabled &&
      normHost(link.host) === normHost(claims.host) &&
      link.repository.toLowerCase() === claims.repository.toLowerCase() &&
      (link.refs === undefined || link.refs.length === 0
        ? true
        : claims.ref !== undefined && link.refs.includes(claims.ref)),
  );
}
