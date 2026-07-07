import { type TenantKeyStore, hashKey } from "@everdict/db";
import type { Authenticator } from "./principal.js";

export interface ApiKeyAuthOptions {
  keyStore: TenantKeyStore;
  roles?: string[]; // 키 = 운영자 발급 워크스페이스 머신 자격 → 기본 풀 권한(admin)
}

// API 키(ak_) 인증기 — 에이전트/MCP/CI 용. 키 해시 → 워크스페이스(tenant) + 발급자(owner) + 키별 scope.
// 개인 키(owner=발급자 subject): 발급자로 해석 → applyActiveWorkspace 가 그 사람의 멤버십 역할을 부여한다
//   (멤버 키=멤버 권한, admin 블랭킷 아님). 비-멤버면 viewer 로 폴백(권한 상승 없음).
// 머신 키(owner=""; 레거시/internal 발급): 종전대로 워크스페이스 머신 자격(roles 기본=admin).
// scope 가 있으면 Principal 에 실어 authz can() 이 role 권한과 교집합으로 키를 더 좁힌다(레거시/미지정=무제한).
export function apiKeyAuthenticator(opts: ApiKeyAuthOptions): Authenticator {
  const roles = opts.roles ?? ["admin"];
  return {
    async authenticate(bearer) {
      if (!bearer.startsWith("ak_")) return undefined;
      const resolved = await opts.keyStore.resolveByHash(hashKey(bearer));
      if (!resolved) return undefined;
      const { tenant: workspace, owner, scopes } = resolved;
      if (owner) return { subject: owner, workspace, roles: ["viewer"], via: "api-key", scopes };
      return { subject: `key:${workspace}`, workspace, roles, via: "api-key", scopes };
    },
  };
}
