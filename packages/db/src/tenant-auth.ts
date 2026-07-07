import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "./client.js";

// 테넌트 API 키 저장소 — 평문은 절대 저장하지 않고 SHA-256 해시만 보관한다.
// self-serve 관리(목록/취소)를 위해 비-비밀 메타데이터(id/label/prefix/scopes)를 함께 보관:
//  - id     = 안정적 식별자(취소 대상 지정용; key_hash 를 노출하지 않기 위함)
//  - label  = 사람이 붙인 이름(선택)
//  - prefix = ak_abcd… (평문 앞부분 식별 힌트 — 해시/평문이 아님; 목록에서 키를 구분하는 용도)
//  - scopes = 키별 권한 범위(read|write|admin). 미지정(레거시 행/full access)이면 undefined = 무제한.
//             권한 매트릭스(scope→action)는 @everdict/auth 가 소유한다(여기는 dumb 문자열 저장소; 순환 의존 방지).
export interface TenantKeyMeta {
  id: string;
  label?: string;
  prefix: string;
  scopes?: string[];
  createdAt: string;
}

// auth 경로의 키 해석 결과 — 워크스페이스 + 발급자(owner) + 키별 스코프(있으면).
// owner="" = 레거시 워크스페이스 머신 키(admin), owner=<subject> = 그 유저의 개인 키(발급자 역할로 해석).
export interface ResolvedKey {
  tenant: string;
  owner: string;
  scopes?: string[]; // 미지정(레거시/full access) → undefined = 무제한
}

export interface TenantKeyStore {
  // meta 미지정(테스트/부트스트랩)이면 id 는 자동 생성, prefix 는 빈 문자열, scopes 는 무제한, owner 는 ""(머신 키). issueKey 가 정식 발급 경로다.
  add(
    tenant: string,
    keyHash: string,
    meta?: { id?: string; label?: string; prefix?: string; scopes?: string[]; owner?: string },
  ): Promise<void>;
  resolveByHash(keyHash: string): Promise<ResolvedKey | undefined>; // auth 경로(불변) — 해시로 워크스페이스+발급자+스코프 해석
  // 메타만(key_hash/평문 없음). owner 주면 그 유저의 개인 키만(셀프 목록), 미지정이면 워크스페이스 전체(머신 키 관리).
  list(tenant: string, owner?: string): Promise<TenantKeyMeta[]>;
  // tenant 스코프 취소 — 다른 워크스페이스 id 는 no-op. owner 주면 그 owner 의 키만 취소(남의 키 취소 방지).
  revoke(tenant: string, id: string, owner?: string): Promise<void>;
}

interface KeyRow {
  tenant: string;
  owner: string;
  id: string;
  label?: string;
  prefix: string;
  scopes?: string[];
  createdAt: string;
}

// 스코프 ↔ 저장 문자열(공백 구분). 빈 배열/미지정은 NULL(=무제한)로 저장한다.
function serializeScopes(scopes?: string[]): string | null {
  return scopes && scopes.length > 0 ? scopes.join(" ") : null;
}
function parseScopes(text: string | null | undefined): string[] | undefined {
  if (!text) return undefined;
  const parts = text.split(" ").filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export class InMemoryTenantKeyStore implements TenantKeyStore {
  private readonly byHash = new Map<string, KeyRow>(); // keyHash → row
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}
  async add(
    tenant: string,
    keyHash: string,
    meta?: { id?: string; label?: string; prefix?: string; scopes?: string[]; owner?: string },
  ): Promise<void> {
    this.byHash.set(keyHash, {
      tenant,
      owner: meta?.owner ?? "",
      id: meta?.id ?? randomUUID(),
      label: meta?.label,
      prefix: meta?.prefix ?? "",
      scopes: meta?.scopes && meta.scopes.length > 0 ? meta.scopes : undefined,
      createdAt: this.now(),
    });
  }
  async resolveByHash(keyHash: string): Promise<ResolvedKey | undefined> {
    const row = this.byHash.get(keyHash);
    return row ? { tenant: row.tenant, owner: row.owner, scopes: row.scopes } : undefined;
  }
  async list(tenant: string, owner?: string): Promise<TenantKeyMeta[]> {
    return [...this.byHash.values()]
      .filter((r) => r.tenant === tenant && (owner === undefined || r.owner === owner))
      .map((r) => ({ id: r.id, label: r.label, prefix: r.prefix, scopes: r.scopes, createdAt: r.createdAt }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 최신순
  }
  async revoke(tenant: string, id: string, owner?: string): Promise<void> {
    for (const [hash, row] of this.byHash)
      if (row.tenant === tenant && row.id === id && (owner === undefined || row.owner === owner))
        this.byHash.delete(hash);
  }
}

export class PgTenantKeyStore implements TenantKeyStore {
  constructor(private readonly client: SqlClient) {}
  async add(
    tenant: string,
    keyHash: string,
    meta?: { id?: string; label?: string; prefix?: string; scopes?: string[]; owner?: string },
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_tenant_keys (key_hash, tenant, owner, id, label, prefix, scopes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) ON CONFLICT (key_hash) DO NOTHING`,
      [
        keyHash,
        tenant,
        meta?.owner ?? "",
        meta?.id ?? randomUUID(),
        meta?.label ?? null,
        meta?.prefix ?? "",
        serializeScopes(meta?.scopes),
      ],
    );
  }
  async resolveByHash(keyHash: string): Promise<ResolvedKey | undefined> {
    const res = await this.client.query<{ tenant: string; owner: string; scopes: string | null }>(
      "SELECT tenant, owner, scopes FROM everdict_tenant_keys WHERE key_hash = $1",
      [keyHash],
    );
    const row = res.rows[0];
    return row ? { tenant: row.tenant, owner: row.owner, scopes: parseScopes(row.scopes) } : undefined;
  }
  async list(tenant: string, owner?: string): Promise<TenantKeyMeta[]> {
    // key_hash 는 select 하지 않는다(절대 노출 금지). prefix 는 레거시 행 대비 COALESCE.
    const res = await this.client.query<{
      id: string;
      label: string | null;
      prefix: string;
      scopes: string | null;
      created_at: string;
    }>(
      "SELECT id, label, COALESCE(prefix, '') AS prefix, scopes, created_at FROM everdict_tenant_keys WHERE tenant = $1 AND ($2::text IS NULL OR owner = $2) ORDER BY created_at DESC",
      [tenant, owner ?? null],
    );
    return res.rows.map((x) => ({
      id: x.id,
      label: x.label ?? undefined,
      prefix: x.prefix,
      scopes: parseScopes(x.scopes),
      createdAt: x.created_at,
    }));
  }
  async revoke(tenant: string, id: string, owner?: string): Promise<void> {
    await this.client.query(
      "DELETE FROM everdict_tenant_keys WHERE tenant = $1 AND id = $2 AND ($3::text IS NULL OR owner = $3)",
      [tenant, id, owner ?? null],
    );
  }
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ak_<랜덤> — 평문 키. 발급 시 한 번만 노출되고, 저장은 해시만.
export function generateKey(): string {
  return `ak_${randomBytes(24).toString("base64url")}`;
}

// 테넌트에 새 키 발급 → 해시 + 비-비밀 메타(id/label/prefix/scopes) 저장, 평문 반환(호출부가 한 번 보여주고 버린다).
// scopes 미지정이면 무제한(full access)로 저장된다 — 스코프 기본값(예: ["admin"]) 결정은 호출부(API/MCP 경계)의 책임.
// Bearer 키 → workspace/scopes 해석은 컨트롤플레인 인증 코어(`@everdict/auth`의 apiKeyAuthenticator)가
// `resolveByHash(hashKey(...))` 로 직접 수행한다. 여기는 저장소 프리미티브만 제공한다.
export async function issueKey(
  store: TenantKeyStore,
  tenant: string,
  label?: string,
  scopes?: string[],
  owner?: string, // 발급자 subject(개인 키). 미지정=""(워크스페이스 머신 키, admin 해석).
): Promise<string> {
  const key = generateKey();
  const prefix = key.slice(0, 12); // "ak_" + 처음 9자 — 목록 식별 힌트(해시/평문 아님)
  await store.add(tenant, hashKey(key), { id: randomUUID(), label, prefix, scopes, owner });
  return key; // 평문 반환
}
