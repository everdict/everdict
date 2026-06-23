import { type TenantKeyStore, hashKey } from "@assay/db";
import type { Authenticator } from "./principal.js";

export interface ApiKeyAuthOptions {
  keyStore: TenantKeyStore;
  roles?: string[]; // 키 = 운영자 발급 워크스페이스 머신 자격 → 기본 풀 권한(admin)
}

// API 키(ak_) 인증기 — 에이전트/MCP/CI 용. 키 해시 → 워크스페이스(tenant) + 키별 scope.
// scope 가 있으면 Principal 에 실어 보낸다 — authz can() 이 role 권한과 교집합으로 키를 좁힌다.
// scope 없는(레거시/full access) 키는 scope 미설정 → 무제한(기존 동작).
export function apiKeyAuthenticator(opts: ApiKeyAuthOptions): Authenticator {
  const roles = opts.roles ?? ["admin"];
  return {
    async authenticate(bearer) {
      if (!bearer.startsWith("ak_")) return undefined;
      const resolved = await opts.keyStore.resolveByHash(hashKey(bearer));
      if (!resolved) return undefined;
      const { tenant: workspace, scopes } = resolved;
      return { subject: `key:${workspace}`, workspace, roles, via: "api-key", scopes };
    },
  };
}
