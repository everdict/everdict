import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import { ASSAY_ROLES } from "./authz.js";
import type { Authenticator } from "./principal.js";

export interface OidcAuthOptions {
  issuer: string; // 예: http://localhost:8080/realms/assay
  audience?: string;
  jwksUri?: string; // 기본 `${issuer}/protocol/openid-connect/certs`
  workspaceClaim?: string; // 기본 "workspace"
  groupPrefix?: string; // 폴백: groups 중 이 접두사 첫 그룹 → 워크스페이스. 기본 "/workspaces/"
  keySet?: JWTVerifyGetKey; // 테스트 주입(로컬 키셋)
}

function looksLikeJwt(t: string): boolean {
  return !t.startsWith("ak_") && t.split(".").length === 3;
}

// 워크스페이스 = 토큰의 claim(기본 workspace) 또는 그룹(/workspaces/<ws>/…)에서 파생.
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

// 역할 = Keycloak realm_access.roles 중 Assay 역할만. 없으면 viewer.
function extractRoles(payload: Record<string, unknown>): string[] {
  const realm = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
  const all = Array.isArray(realm) ? realm.filter((r): r is string => typeof r === "string") : [];
  const known = all.filter((r) => (ASSAY_ROLES as readonly string[]).includes(r));
  return known.length > 0 ? known : ["viewer"];
}

// Keycloak(OIDC) JWT 검증 인증기 — JWKS 로 서명 검증, issuer/audience 확인, 워크스페이스/역할 추출.
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
        const workspace = extractWorkspace(payload as Record<string, unknown>, workspaceClaim, groupPrefix);
        if (!workspace) return undefined;
        return {
          subject: String(payload.sub ?? ""),
          workspace,
          roles: extractRoles(payload as Record<string, unknown>),
          via: "oidc",
        };
      } catch {
        return undefined; // 검증 실패 → 미인증
      }
    },
  };
}
