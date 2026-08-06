// The authenticated subject. The result of authentication, owned by the control plane.
// workspace = tenant = trust-zone key — members of the same workspace run in the same zone (isolation/warm pool).
export interface Principal {
  subject: string; // user sub (OIDC) or key identifier — the identity key (authz/scope use only this value)
  workspace: string; // = tenant (the key for isolation/fairness/budget/store/registry)
  roles: string[]; // ["admin"|"member"|"viewer"|"runner"|"ci"...]
  // runner = self-hosted runner pairing token (rnr_) — least privilege, fixed workspace.
  // github-actions = GitHub Actions OIDC federation (repo link trust) — ci role, not membership.
  // agent = an autonomous agent execution credential (agt_) for request-less teammate/proactive turns — acts AS its
  // creator (subject), so it gets the creator's membership role, further capped by scope (default write, no governance).
  // See docs/architecture/agent-execution-auth.md.
  via: "oidc" | "api-key" | "runner" | "github-actions" | "agent";
  email?: string; // OIDC email/preferred_username claim — for the member list display (display only, unrelated to authz/identity). Absent for api-key.
  name?: string; // OIDC name claim (given+family fallback) — seeds the user profile so "who did this" surfaces show a real name, never the opaque sub. Display only, unrelated to authz/identity. Absent for api-key.
  scopes?: string[]; // per-api-key permission scope (read|write|admin). If present, narrowed by intersection with role permissions. If absent (OIDC/legacy key), unlimited. See authz.ts can().
  runnerId?: string; // only for a runner token (via=runner) — which device. The lease/result tools use (workspace, subject, runnerId).
  // The teams this subject belongs to IN `workspace` — resolved per request alongside the membership role, because
  // team membership is its own roster (a workspace member is not automatically in every team). It is an
  // AUTHORIZATION input, not just display: a write against a resource owned by a team the subject is not on is
  // refused (see can() in authz.ts). Absent/empty = on no team, which can still act on unowned resources and,
  // for an admin, on everything. Never trusted from the client — the control plane loads it.
  teams?: string[];
}

// Authentication request context — hints from outside the bearer. workspaceHint = x-everdict-workspace header (the workspace the request targets).
// Used by the GitHub Actions federation to match against "only that workspace's repo links" (no global repo reverse-index, no cross-tenant ambiguity).
export interface AuthContext {
  workspaceHint?: string;
}
