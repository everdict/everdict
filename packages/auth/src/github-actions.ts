import { type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { AuthContext, Authenticator, Principal } from "./principal.js";

// GitHub Actions OIDC 페더레이션 — 워크플로가 발급받는 GitHub 서명 JWT(aud=assay)를 keyless 자격증명으로 받는다.
// 신뢰는 워크스페이스의 repo link(WorkspaceSettings.ci.links)가 결정: 요청이 지목한 워크스페이스(workspaceHint)의
// link 에 토큰의 repository 클레임이 매칭될 때만 Principal(roles=["ci"]) 발급 — 레포 시크릿에 장기 키가 필요 없다.
// 설계: docs/architecture/github-actions-trigger.md (D4). AWS/GCP 의 GH OIDC 페더레이션과 동일 패턴.

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_AUDIENCE = "assay";

// 검증된 토큰에서 뽑는 CI 실행 좌표 — trust 매칭(repository) + provenance 참고용.
export interface GithubActionsClaims {
  repository: string; // "owner/name"
  ref?: string;
  sha?: string;
  workflow?: string;
  eventName?: string;
}

export interface GithubActionsAuthOptions {
  issuer?: string; // 기본 github.com 공용 issuer(GHES 는 별도 issuer)
  audience?: string; // 기본 "assay" — 워크플로가 이 audience 로 토큰을 요청해야 한다
  jwksUri?: string; // 기본 `${issuer}/.well-known/jwks`
  keySet?: JWTVerifyGetKey; // 테스트 주입(로컬 키셋)
  // 검증된 repository 클레임 ↔ 워크스페이스 repo link 대조. 매칭 없으면 undefined(=미인증 401, fail-closed).
  // 반환 roles 는 보통 ["ci"](scorecards:run/read + 재핀만). workspaceHint 없으면 대조 불가 → 미인증.
  resolveTrust: (
    claims: GithubActionsClaims,
    workspaceHint: string,
  ) => Promise<{ workspace: string; roles: string[] } | undefined>;
}

// GitHub Actions OIDC JWT 검증 인증기. issuer 프리체크(decode)로 다른 발급자의 JWT 는 조용히 패스(composite 소음 방지).
export function githubActionsAuthenticator(opts: GithubActionsAuthOptions): Authenticator {
  const issuer = (opts.issuer ?? GITHUB_ACTIONS_ISSUER).replace(/\/$/, "");
  const audience = opts.audience ?? GITHUB_ACTIONS_AUDIENCE;
  const jwks = opts.keySet ?? createRemoteJWKSet(new URL(opts.jwksUri ?? `${issuer}/.well-known/jwks`));

  return {
    async authenticate(bearer, ctx?: AuthContext): Promise<Principal | undefined> {
      if (bearer.split(".").length !== 3) return undefined; // JWT 아님(ak_/rnr_ 등) — 내 자격증명 아님
      try {
        // issuer 프리체크 — Keycloak 등 다른 발급자 토큰은 검증 시도 없이 패스(그쪽 인증기가 처리).
        if (decodeJwt(bearer).iss !== issuer) return undefined;
      } catch {
        return undefined;
      }
      const hint = ctx?.workspaceHint;
      if (!hint) return undefined; // 어느 워크스페이스의 link 와 대조할지 없음 — fail-closed
      try {
        const { payload } = await jwtVerify(bearer, jwks, { issuer, audience });
        const repository = typeof payload.repository === "string" ? payload.repository : undefined;
        if (!repository) return undefined;
        const claims: GithubActionsClaims = {
          repository,
          ...(typeof payload.ref === "string" ? { ref: payload.ref } : {}),
          ...(typeof payload.sha === "string" ? { sha: payload.sha } : {}),
          ...(typeof payload.workflow === "string" ? { workflow: payload.workflow } : {}),
          ...(typeof payload.event_name === "string" ? { eventName: payload.event_name } : {}),
        };
        const trust = await opts.resolveTrust(claims, hint);
        if (!trust) return undefined; // repo link 없음 → 미인증(404/403 이 아니라 401 — 존재 누출 없음)
        return {
          subject: `gha:${repository}`, // identity 키 — 레포 단위(사람 아님, 멤버십 부트스트랩 제외 대상)
          workspace: trust.workspace,
          roles: trust.roles,
          via: "github-actions",
        };
      } catch {
        return undefined; // 서명/만료/aud 실패 → fail-closed
      }
    },
  };
}
