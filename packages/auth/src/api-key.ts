import { type TenantKeyStore, hashKey } from "@assay/db";
import type { Authenticator } from "./principal.js";

export interface ApiKeyAuthOptions {
  keyStore: TenantKeyStore;
  roles?: string[]; // 키 = 운영자 발급 워크스페이스 머신 자격 → 기본 풀 권한(admin)
}

// API 키(ak_) 인증기 — 에이전트/MCP/CI 용. 키 해시 → 워크스페이스(tenant).
export function apiKeyAuthenticator(opts: ApiKeyAuthOptions): Authenticator {
  const roles = opts.roles ?? ["admin"];
  return {
    async authenticate(bearer) {
      if (!bearer.startsWith("ak_")) return undefined;
      const workspace = await opts.keyStore.tenantForHash(hashKey(bearer));
      if (!workspace) return undefined;
      return { subject: `key:${workspace}`, workspace, roles, via: "api-key" };
    },
  };
}
