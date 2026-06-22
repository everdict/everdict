import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "./client.js";

// 테넌트 API 키 저장소 — 평문은 절대 저장하지 않고 SHA-256 해시만 보관한다.
// self-serve 관리(목록/취소)를 위해 비-비밀 메타데이터(id/label/prefix)를 함께 보관:
//  - id     = 안정적 식별자(취소 대상 지정용; key_hash 를 노출하지 않기 위함)
//  - label  = 사람이 붙인 이름(선택)
//  - prefix = ak_abcd… (평문 앞부분 식별 힌트 — 해시/평문이 아님; 목록에서 키를 구분하는 용도)
export interface TenantKeyMeta {
  id: string;
  label?: string;
  prefix: string;
  createdAt: string;
}

export interface TenantKeyStore {
  // meta 미지정(테스트/부트스트랩)이면 id 는 자동 생성, prefix 는 빈 문자열. issueKey 가 정식 발급 경로다.
  add(tenant: string, keyHash: string, meta?: { id?: string; label?: string; prefix?: string }): Promise<void>;
  tenantForHash(keyHash: string): Promise<string | undefined>; // auth 경로(불변) — 해시로 워크스페이스 해석
  list(tenant: string): Promise<TenantKeyMeta[]>; // 메타만 — key_hash/평문은 절대 반환하지 않는다
  revoke(tenant: string, id: string): Promise<void>; // tenant 스코프 — 다른 워크스페이스 id 는 no-op
}

interface KeyRow {
  tenant: string;
  id: string;
  label?: string;
  prefix: string;
  createdAt: string;
}

export class InMemoryTenantKeyStore implements TenantKeyStore {
  private readonly byHash = new Map<string, KeyRow>(); // keyHash → row
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}
  async add(tenant: string, keyHash: string, meta?: { id?: string; label?: string; prefix?: string }): Promise<void> {
    this.byHash.set(keyHash, {
      tenant,
      id: meta?.id ?? randomUUID(),
      label: meta?.label,
      prefix: meta?.prefix ?? "",
      createdAt: this.now(),
    });
  }
  async tenantForHash(keyHash: string): Promise<string | undefined> {
    return this.byHash.get(keyHash)?.tenant;
  }
  async list(tenant: string): Promise<TenantKeyMeta[]> {
    return [...this.byHash.values()]
      .filter((r) => r.tenant === tenant)
      .map((r) => ({ id: r.id, label: r.label, prefix: r.prefix, createdAt: r.createdAt }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 최신순
  }
  async revoke(tenant: string, id: string): Promise<void> {
    for (const [hash, row] of this.byHash) if (row.tenant === tenant && row.id === id) this.byHash.delete(hash);
  }
}

export class PgTenantKeyStore implements TenantKeyStore {
  constructor(private readonly client: SqlClient) {}
  async add(tenant: string, keyHash: string, meta?: { id?: string; label?: string; prefix?: string }): Promise<void> {
    await this.client.query(
      `INSERT INTO assay_tenant_keys (key_hash, tenant, id, label, prefix, created_at)
       VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (key_hash) DO NOTHING`,
      [keyHash, tenant, meta?.id ?? randomUUID(), meta?.label ?? null, meta?.prefix ?? ""],
    );
  }
  async tenantForHash(keyHash: string): Promise<string | undefined> {
    const res = await this.client.query<{ tenant: string }>(
      "SELECT tenant FROM assay_tenant_keys WHERE key_hash = $1",
      [keyHash],
    );
    return res.rows[0]?.tenant;
  }
  async list(tenant: string): Promise<TenantKeyMeta[]> {
    // key_hash 는 select 하지 않는다(절대 노출 금지). prefix 는 레거시 행 대비 COALESCE.
    const res = await this.client.query<{ id: string; label: string | null; prefix: string; created_at: string }>(
      "SELECT id, label, COALESCE(prefix, '') AS prefix, created_at FROM assay_tenant_keys WHERE tenant = $1 ORDER BY created_at DESC",
      [tenant],
    );
    return res.rows.map((x) => ({
      id: x.id,
      label: x.label ?? undefined,
      prefix: x.prefix,
      createdAt: x.created_at,
    }));
  }
  async revoke(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM assay_tenant_keys WHERE tenant = $1 AND id = $2", [tenant, id]);
  }
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ak_<랜덤> — 평문 키. 발급 시 한 번만 노출되고, 저장은 해시만.
export function generateKey(): string {
  return `ak_${randomBytes(24).toString("base64url")}`;
}

// 테넌트에 새 키 발급 → 해시 + 비-비밀 메타(id/label/prefix) 저장, 평문 반환(호출부가 한 번 보여주고 버린다).
// Bearer 키 → workspace 해석은 컨트롤플레인 인증 코어(`@assay/auth`의 apiKeyAuthenticator)가
// `tenantForHash(hashKey(...))` 로 직접 수행한다. 여기는 저장소 프리미티브만 제공한다.
export async function issueKey(store: TenantKeyStore, tenant: string, label?: string): Promise<string> {
  const key = generateKey();
  const prefix = key.slice(0, 12); // "ak_" + 처음 9자 — 목록 식별 힌트(해시/평문 아님)
  await store.add(tenant, hashKey(key), { id: randomUUID(), label, prefix });
  return key;
}
