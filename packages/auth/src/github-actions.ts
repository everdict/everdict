import { type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { AuthContext, Authenticator, Principal } from "./principal.js";

// GitHub Actions OIDC 페더레이션 — 워크플로가 발급받는 GitHub 서명 JWT(aud=everdict)를 keyless 자격증명으로 받는다.
// 신뢰는 워크스페이스의 repo link(WorkspaceSettings.ci.links)가 결정: 요청이 지목한 워크스페이스(workspaceHint)의
// link 에 토큰의 repository 클레임이 매칭될 때만 Principal(roles=["ci"]) 발급 — 레포 시크릿에 장기 키가 필요 없다.
// 설계: docs/architecture/github-actions-trigger.md (D4). AWS/GCP 의 GH OIDC 페더레이션과 동일 패턴.

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_AUDIENCE = "everdict";

// GHES(Actions) OIDC issuer — GHE 베이스 URL 로부터. github.com 과 달리 인스턴스별 issuer 를 쓴다.
export function githubEnterpriseIssuer(host: string): string {
  return `${host.replace(/\/$/, "")}/_services/token`;
}

// 검증된 토큰에서 뽑는 CI 실행 좌표 — trust 매칭(repository+host) + provenance 참고용.
export interface GithubActionsClaims {
  repository: string; // "owner/name"
  host?: string; // GHE 베이스 URL(예: "https://ghe.acme.io") — 미지정 = github.com. issuer 로부터 확정된 값.
  ref?: string;
  sha?: string;
  workflow?: string;
  eventName?: string;
}

// GHES 페더레이션 — GHE host 는 워크스페이스가 등록하는 동적 값이라 정적 issuer 목록이 불가능하다.
// 지목된 워크스페이스의 신뢰 후보 host 목록(보통 repo link 들의 host 집합)을 풀어 issuer 를 대조한다(fail-closed).
export interface GithubActionsEnterpriseOptions {
  hostsFor: (workspaceHint: string) => Promise<string[]>; // 허용 GHE 베이스 URL 들 — 없으면 GHES 토큰 전부 미인증
  keySetFor?: (issuer: string) => JWTVerifyGetKey; // 테스트 주입 — 기본은 `${issuer}/.well-known/jwks` 원격 로드(캐시)
}

export interface GithubActionsAuthOptions {
  issuer?: string; // 기본 github.com 공용 issuer(GHES 는 enterprise 옵션으로)
  audience?: string; // 기본 "everdict" — 워크플로가 이 audience 로 토큰을 요청해야 한다
  jwksUri?: string; // 기본 `${issuer}/.well-known/jwks`
  keySet?: JWTVerifyGetKey; // 테스트 주입(로컬 키셋)
  enterprise?: GithubActionsEnterpriseOptions; // GHES issuer(https://<host>/_services/token) 신뢰
  // 검증된 repository(+host) 클레임 ↔ 워크스페이스 repo link 대조. 매칭 없으면 undefined(=미인증 401, fail-closed).
  // 반환 roles 는 보통 ["ci"](scorecards:run/read + 재핀만). workspaceHint 없으면 대조 불가 → 미인증.
  resolveTrust: (
    claims: GithubActionsClaims,
    workspaceHint: string,
  ) => Promise<{ workspace: string; roles: string[] } | undefined>;
}

// GitHub Actions OIDC JWT 검증 인증기. issuer 프리체크(decode)로 다른 발급자의 JWT 는 조용히 패스(composite 소음 방지).
// github.com 공용 issuer 는 정적으로, GHES issuer 는 enterprise.hostsFor(워크스페이스의 신뢰 host 집합)로 동적으로 신뢰한다.
export function githubActionsAuthenticator(opts: GithubActionsAuthOptions): Authenticator {
  const issuer = (opts.issuer ?? GITHUB_ACTIONS_ISSUER).replace(/\/$/, "");
  const audience = opts.audience ?? GITHUB_ACTIONS_AUDIENCE;
  const jwks = opts.keySet ?? createRemoteJWKSet(new URL(opts.jwksUri ?? `${issuer}/.well-known/jwks`));
  const enterpriseJwks = new Map<string, JWTVerifyGetKey>(); // GHES issuer → JWKS(원격 로드 캐시)
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
      if (bearer.split(".").length !== 3) return undefined; // JWT 아님(ak_/rnr_ 등) — 내 자격증명 아님
      let iss: string;
      try {
        // issuer 프리체크 — Keycloak 등 다른 발급자 토큰은 검증 시도 없이 패스(그쪽 인증기가 처리).
        const decoded = decodeJwt(bearer).iss;
        if (typeof decoded !== "string") return undefined;
        iss = decoded;
      } catch {
        return undefined;
      }
      const hint = ctx?.workspaceHint;
      if (!hint) return undefined; // 어느 워크스페이스의 link 와 대조할지 없음 — fail-closed
      try {
        let host: string | undefined; // GHE 베이스 URL(github.com 이면 undefined) — issuer 로부터 확정
        let keys: JWTVerifyGetKey;
        if (iss === issuer) {
          keys = jwks;
        } else {
          // GHES 후보 — 지목된 워크스페이스가 신뢰하는 host 의 issuer 일 때만 검증(미등록 GHE 는 조용히 패스).
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
