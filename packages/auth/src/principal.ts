// The authenticated subject. The result of authentication, owned by the control plane.
// workspace = tenant = trust-zone key — members of the same workspace run in the same zone (isolation/warm pool).
export interface Principal {
  subject: string; // user sub (OIDC) or key identifier — the identity key (authz/scope use only this value)
  workspace: string; // = tenant (the key for isolation/fairness/budget/store/registry)
  roles: string[]; // ["admin"|"member"|"viewer"|"runner"|"ci"...]
  // runner = self-hosted runner pairing token (rnr_) — least privilege, fixed workspace.
  // github-actions = GitHub Actions OIDC federation (repo link trust) — ci role, not membership.
  via: "oidc" | "api-key" | "runner" | "github-actions";
  email?: string; // OIDC email/preferred_username claim — for the member list display (display only, unrelated to authz/identity). Absent for api-key.
  scopes?: string[]; // per-api-key permission scope (read|write|admin). If present, narrowed by intersection with role permissions. If absent (OIDC/legacy key), unlimited. See authz.ts can().
  runnerId?: string; // only for a runner token (via=runner) — which device. The lease/result tools use (workspace, subject, runnerId).
}

// Authentication request context — hints from outside the bearer. workspaceHint = x-everdict-workspace header (the workspace the request targets).
// Used by the GitHub Actions federation to match against "only that workspace's repo links" (no global repo reverse-index, no cross-tenant ambiguity).
export interface AuthContext {
  workspaceHint?: string;
}

// Bearer credential → Principal. Handles both JWT (human/Keycloak) and API key (agent/MCP/CI).
export interface Authenticator {
  authenticate(bearer: string, ctx?: AuthContext): Promise<Principal | undefined>;
}

// Tries multiple authenticators in order, returns the first success.
export function compositeAuthenticator(authenticators: Authenticator[]): Authenticator {
  return {
    async authenticate(bearer, ctx) {
      for (const a of authenticators) {
        const p = await a.authenticate(bearer, ctx);
        if (p) return p;
      }
      return undefined;
    },
  };
}
