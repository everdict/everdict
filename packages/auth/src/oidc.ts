import { type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { Authenticator } from "./principal.js";

// Verification-failure diagnostics (the upper app logs these). Values decoded only to understand the reason, without trusting the token.
export interface OidcVerifyErrorInfo {
  code: string; // jose error code (ERR_JWT_EXPIRED, etc.) | "JWKS_FETCH_FAILED" (network/DNS/TLS) | "UNKNOWN"
  message: string; // original error message (summary)
  expectedIssuer: string; // the issuer the control plane expects (= KEYCLOAK_ISSUER)
  tokenIssuer?: string; // the token's iss (decoded before verification) — for diagnosing issuer mismatch
  tokenAudience?: unknown; // the token's aud — for diagnosing audience mismatch
  claimKeys?: string[]; // the token's top-level claim names — for diagnosing whether workspaceClaim is present
}

export interface OidcAuthOptions {
  issuer: string; // e.g. http://localhost:8080/realms/everdict
  audience?: string;
  jwksUri?: string; // default `${issuer}/protocol/openid-connect/certs`
  workspaceClaim?: string; // default "workspace"
  groupPrefix?: string; // fallback: the first group with this prefix → workspace. default "/workspaces/"
  keySet?: JWTVerifyGetKey; // test injection (local key set)
  // Notifies the upper (app) so it can log the JWT verification-failure reason (to diagnose a 401). The normal "not my credential"
  // (ak_ API key / non-JWT) does not call this — only when verification was attempted and failed. A callback exception never breaks authentication.
  onError?: (info: OidcVerifyErrorInfo) => void;
}

function looksLikeJwt(t: string): boolean {
  return !t.startsWith("ak_") && t.split(".").length === 3;
}

// jose/network error → human-readable diagnostics. Even for a token that failed verification (without trusting it), decodes and records iss/aud/claim keys.
function describeVerifyError(err: unknown, bearer: string, expectedIssuer: string): OidcVerifyErrorInfo {
  const code =
    typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  // JWKS unreachable (the control plane can't reach Keycloak) arrives as a fetch failure, not a jose code — classify it separately so it stands out.
  const isFetchFail =
    code === "ERR_JWKS_TIMEOUT" || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|socket/i.test(message);
  const info: OidcVerifyErrorInfo = { code: isFetchFail ? "JWKS_FETCH_FAILED" : code, message, expectedIssuer };
  try {
    const payload = decodeJwt(bearer);
    if (typeof payload.iss === "string") info.tokenIssuer = payload.iss;
    if (payload.aud !== undefined) info.tokenAudience = payload.aud;
    info.claimKeys = Object.keys(payload);
  } catch {
    // Ignore an undecodable (malformed payload) — the code/message alone is enough to understand the reason.
  }
  return info;
}

// workspace = derived from the token's claim (default workspace) or a group (/workspaces/<ws>/…).
function extractWorkspace(payload: Record<string, unknown>, claim: string, prefix: string): string | undefined {
  const direct = payload[claim];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const groups = payload.groups;
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (typeof g === "string" && g.startsWith(prefix)) {
        return g.slice(prefix.length).split("/")[0];
      }
    }
  }
  return undefined;
}

// A human-readable identifier (for the member list display) — email first, else preferred_username. Display only (unrelated to identity/authz).
function extractEmail(payload: Record<string, unknown>): string | undefined {
  const email = payload.email;
  if (typeof email === "string" && email.length > 0) return email;
  const username = payload.preferred_username;
  if (typeof username === "string" && username.length > 0) return username;
  return undefined;
}

// Keycloak (OIDC) JWT verification authenticator — verify signature via JWKS, check issuer/audience, extract workspace/roles.
export function oidcAuthenticator(opts: OidcAuthOptions): Authenticator {
  const jwks =
    opts.keySet ??
    createRemoteJWKSet(new URL(opts.jwksUri ?? `${opts.issuer.replace(/\/$/, "")}/protocol/openid-connect/certs`));
  const workspaceClaim = opts.workspaceClaim ?? "workspace";
  const groupPrefix = opts.groupPrefix ?? "/workspaces/";

  return {
    async authenticate(bearer) {
      if (!looksLikeJwt(bearer)) return undefined;
      try {
        const { payload } = await jwtVerify(bearer, jwks, {
          issuer: opts.issuer,
          ...(opts.audience ? { audience: opts.audience } : {}),
        });
        // Even without a workspace claim/group (e.g. an external Keycloak with no workspace mapper), a valid token authenticates.
        // Since self-serve membership is the SSOT for workspaces, a user with no claim is left at workspace="" (none yet) and
        // filled in by apps/api's membership resolution (bootstrap) + web onboarding (creating the first workspace).
        // fail-closed applies only to an *unverifiable* token (signature/issuer/audience/expiry failure) — the catch below turns that into undefined.
        const workspace = extractWorkspace(payload as Record<string, unknown>, workspaceClaim, groupPrefix) ?? "";
        const email = extractEmail(payload as Record<string, unknown>);
        return {
          subject: String(payload.sub ?? ""),
          workspace,
          // Keycloak is *authentication only* — never used for authorization (roles). Roles have the workspace membership as SSOT
          // (creator = admin, invite = assigned role, promotion). Token roles like realm_access.roles are deliberately ignored.
          roles: [],
          via: "oidc",
          ...(email ? { email } : {}),
        };
      } catch (err) {
        // Notifies the upper so it can log the verification-failure reason (isolated so a logging failure doesn't break the authentication flow).
        try {
          opts.onError?.(describeVerifyError(err, bearer, opts.issuer));
        } catch {
          // Ignore a callback exception.
        }
        return undefined; // verification failed → unauthenticated
      }
    },
  };
}
