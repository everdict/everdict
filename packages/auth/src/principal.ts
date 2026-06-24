// 인증된 주체. 컨트롤플레인이 소유하는 인증의 결과물.
// workspace = tenant = trust-zone 키 — 같은 워크스페이스 멤버는 같은 존(격리/warm 풀)에서 실행된다.
export interface Principal {
  subject: string; // 유저 sub(OIDC) 또는 키 식별자 — identity 키(authz/스코프는 이 값으로만)
  workspace: string; // = tenant (격리/공정/예산/스토어/레지스트리의 키)
  roles: string[]; // ["admin"|"member"|"viewer"|"runner"...]
  via: "oidc" | "api-key" | "runner"; // runner = 셀프호스티드 러너 페어링 토큰(rnr_) — 최소권한, 고정 워크스페이스
  email?: string; // OIDC email/preferred_username 클레임 — 멤버 목록 표시용(표시 전용, authz/identity 무관). api-key 는 없음.
  scopes?: string[]; // api-key 별 권한 범위(read|write|admin). 있으면 role 권한과 교집합으로 좁힌다. 없으면(OIDC/레거시 키) 무제한. authz.ts can() 참고.
  runnerId?: string; // 러너 토큰(via=runner)일 때만 — 어느 디바이스인지. lease/result 도구가 (workspace,subject,runnerId) 로 쓴다.
}

// Bearer 자격증명 → Principal. JWT(사람/Keycloak)와 API 키(에이전트/MCP/CI) 양쪽을 처리.
export interface Authenticator {
  authenticate(bearer: string): Promise<Principal | undefined>;
}

// 여러 인증기를 순서대로 시도, 첫 성공 반환.
export function compositeAuthenticator(authenticators: Authenticator[]): Authenticator {
  return {
    async authenticate(bearer) {
      for (const a of authenticators) {
        const p = await a.authenticate(bearer);
        if (p) return p;
      }
      return undefined;
    },
  };
}
