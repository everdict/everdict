// 인증된 주체. 컨트롤플레인이 소유하는 인증의 결과물.
// workspace = tenant = trust-zone 키 — 같은 워크스페이스 멤버는 같은 존(격리/warm 풀)에서 실행된다.
export interface Principal {
  subject: string; // 유저 sub(OIDC) 또는 키 식별자
  workspace: string; // = tenant (격리/공정/예산/스토어/레지스트리의 키)
  roles: string[]; // ["admin"|"member"|"viewer"...]
  via: "oidc" | "api-key";
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
