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
  scopes?: string[]; // per-api-key permission scope (read|write|admin). If present, narrowed by intersection with role permissions. If absent (OIDC/legacy key), unlimited. See authz.ts can().
  runnerId?: string; // only for a runner token (via=runner) — which device. The lease/result tools use (workspace, subject, runnerId).
}

// Authentication request context — hints from outside the bearer. workspaceHint = x-everdict-workspace header (the workspace the request targets).
// Used by the GitHub Actions federation to match against "only that workspace's repo links" (no global repo reverse-index, no cross-tenant ambiguity).
export interface AuthContext {
  workspaceHint?: string;
}
