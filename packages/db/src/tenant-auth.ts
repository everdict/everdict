import { createHash, randomBytes } from "node:crypto";
import type { SqlClient } from "./client.js";

// 테넌트 API 키 저장소 — 평문은 절대 저장하지 않고 SHA-256 해시만 보관한다.
export interface TenantKeyStore {
  add(tenant: string, keyHash: string): Promise<void>;
  tenantForHash(keyHash: string): Promise<string | undefined>;
}

export class InMemoryTenantKeyStore implements TenantKeyStore {
  private readonly byHash = new Map<string, string>(); // keyHash → tenant
  async add(tenant: string, keyHash: string): Promise<void> {
    this.byHash.set(keyHash, tenant);
  }
  async tenantForHash(keyHash: string): Promise<string | undefined> {
    return this.byHash.get(keyHash);
  }
}

export class PgTenantKeyStore implements TenantKeyStore {
  constructor(private readonly client: SqlClient) {}
  async add(tenant: string, keyHash: string): Promise<void> {
    await this.client.query(
      "INSERT INTO assay_tenant_keys (tenant, key_hash, created_at) VALUES ($1, $2, now()) ON CONFLICT (key_hash) DO NOTHING",
      [tenant, keyHash],
    );
  }
  async tenantForHash(keyHash: string): Promise<string | undefined> {
    const res = await this.client.query<{ tenant: string }>(
      "SELECT tenant FROM assay_tenant_keys WHERE key_hash = $1",
      [keyHash],
    );
    return res.rows[0]?.tenant;
  }
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ak_<랜덤> — 평문 키. 발급 시 한 번만 노출되고, 저장은 해시만.
export function generateKey(): string {
  return `ak_${randomBytes(24).toString("base64url")}`;
}

// 테넌트에 새 키 발급 → 해시 저장, 평문 반환(호출부가 한 번 보여주고 버린다).
export async function issueKey(store: TenantKeyStore, tenant: string): Promise<string> {
  const key = generateKey();
  await store.add(tenant, hashKey(key));
  return key;
}

// Bearer 키 → tenant 해석.
export interface TenantAuth {
  authenticate(apiKey: string): Promise<string | undefined>;
}

export function keyStoreAuth(store: TenantKeyStore): TenantAuth {
  return {
    async authenticate(apiKey: string): Promise<string | undefined> {
      if (!apiKey) return undefined;
      return store.tenantForHash(hashKey(apiKey));
    },
  };
}
