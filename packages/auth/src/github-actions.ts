import { type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { AuthContext, Authenticator, Principal } from "./principal.js";

// GitHub Actions OIDC federation — accepts the GitHub-signed JWT (aud=everdict) that a workflow mints as a keyless credential.
// Trust is decided by the workspace's repo links (WorkspaceSettings.ci.links): a Principal (roles=["ci"]) is issued only when
// the token's repository claim matches a link of the workspace the request targets (workspaceHint) — no long-lived key needed in a repo secret.
// Design: docs/architecture/github-actions-trigger.md (D4). Same pattern as AWS/GCP's GH OIDC federation.

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_AUDIENCE = "everdict";

// GHES (Actions) OIDC issuer — from the GHE base URL. Unlike github.com, uses a per-instance issuer.
export function githubEnterpriseIssuer(host: string): string {
  return `${host.replace(/\/$/, "")}/_services/token`;
}

// CI run coordinates pulled from the verified token — for trust matching (repository+host) + provenance reference.
export interface GithubActionsClaims {
  repository: string; // "owner/name"
  host?: string; // GHE base URL (e.g. "https://ghe.acme.io") — unset = github.com. A value determined from the issuer.
  ref?: string;
  sha?: string;
  workflow?: string;
  eventName?: string;
}

// GHES federation — the GHE host is a dynamic value the workspace registers, so a static issuer list is impossible.
// Resolves the targeted workspace's candidate trusted host list (usually the host set of its repo links) and matches the issuer against it (fail-closed).
export interface GithubActionsEnterpriseOptions {
  hostsFor: (workspaceHint: string) => Promise<string[]>; // allowed GHE base URLs — if none, all GHES tokens are unauthenticated
  keySetFor?: (issuer: string) => JWTVerifyGetKey; // test injection — default is a remote load (cached) of `${issuer}/.well-known/jwks`
}

export interface GithubActionsAuthOptions {
  issuer?: string; // default github.com public issuer (GHES via the enterprise option)
  audience?: string; // default "everdict" — the workflow must request the token with this audience
  jwksUri?: string; // default `${issuer}/.well-known/jwks`
  keySet?: JWTVerifyGetKey; // test injection (local key set)
  enterprise?: GithubActionsEnterpriseOptions; // trust GHES issuer (https://<host>/_services/token)
  // Match the verified repository (+host) claim ↔ workspace repo link. No match → undefined (= unauthenticated 401, fail-closed).
  // Returned roles are usually ["ci"] (scorecards:run/read + re-pin only). Without workspaceHint there's nothing to match → unauthenticated.
  resolveTrust: (
    claims: GithubActionsClaims,
    workspaceHint: string,
  ) => Promise<{ workspace: string; roles: string[] } | undefined>;
}

// GitHub Actions OIDC JWT verification authenticator. An issuer pre-check (decode) silently passes other issuers' JWTs (avoids composite noise).
// The github.com public issuer is trusted statically; the GHES issuer is trusted dynamically via enterprise.hostsFor (the workspace's trusted host set).
export function githubActionsAuthenticator(opts: GithubActionsAuthOptions): Authenticator {
  const issuer = (opts.issuer ?? GITHUB_ACTIONS_ISSUER).replace(/\/$/, "");
  const audience = opts.audience ?? GITHUB_ACTIONS_AUDIENCE;
  const jwks = opts.keySet ?? createRemoteJWKSet(new URL(opts.jwksUri ?? `${issuer}/.well-known/jwks`));
  const enterpriseJwks = new Map<string, JWTVerifyGetKey>(); // GHES issuer → JWKS (remote-load cache)
  const keysForEnterprise = (iss: string): JWTVerifyGetKey => {
    const injected = opts.enterprise?.keySetFor?.(iss);
    if (injected) return injected;
    let cached = enterpriseJwks.get(iss);
    if (!cached) {
      cached = createRemoteJWKSet(new URL(`${iss}/.well-known/jwks`));
      enterpriseJwks.set(iss, cached);
    }
    return cached;
  };

  return {
    async authenticate(bearer, ctx?: AuthContext): Promise<Principal | undefined> {
      if (bearer.split(".").length !== 3) return undefined; // not a JWT (ak_/rnr_, etc.) — not my credential
      let iss: string;
      try {
        // issuer pre-check — other issuers' tokens (Keycloak, etc.) pass without a verification attempt (their authenticator handles them).
        const decoded = decodeJwt(bearer).iss;
        if (typeof decoded !== "string") return undefined;
        iss = decoded;
      } catch {
        return undefined;
      }
      const hint = ctx?.workspaceHint;
      if (!hint) return undefined; // nothing to match against any workspace's link — fail-closed
      try {
        let host: string | undefined; // GHE base URL (undefined for github.com) — determined from the issuer
        let keys: JWTVerifyGetKey;
        if (iss === issuer) {
          keys = jwks;
        } else {
          // GHES candidate — verify only when it's the issuer of a host the targeted workspace trusts (an unregistered GHE passes silently).
          if (!opts.enterprise) return undefined;
          const hosts = await opts.enterprise.hostsFor(hint);
          host = hosts.find((h) => githubEnterpriseIssuer(h) === iss);
          if (!host) return undefined;
          keys = keysForEnterprise(iss);
        }
        const { payload } = await jwtVerify(bearer, keys, { issuer: iss, audience });
        const repository = typeof payload.repository === "string" ? payload.repository : undefined;
        if (!repository) return undefined;
        const claims: GithubActionsClaims = {
          repository,
          ...(host !== undefined ? { host } : {}),
          ...(typeof payload.ref === "string" ? { ref: payload.ref } : {}),
          ...(typeof payload.sha === "string" ? { sha: payload.sha } : {}),
          ...(typeof payload.workflow === "string" ? { workflow: payload.workflow } : {}),
          ...(typeof payload.event_name === "string" ? { eventName: payload.event_name } : {}),
        };
        const trust = await opts.resolveTrust(claims, hint);
        if (!trust) return undefined; // no repo link → unauthenticated (401, not 404/403 — no existence leak)
        return {
          subject: `gha:${repository}`, // identity key — per repo (not a person, excluded from membership bootstrap)
          workspace: trust.workspace,
          roles: trust.roles,
          via: "github-actions",
        };
      } catch {
        return undefined; // signature/expiry/aud failure → fail-closed
      }
    },
  };
}
