import { ConflictError, NotFoundError, type RuntimeSpec } from "@everdict/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// Runtime(실행 인프라) 버전 SSOT — (tenant, id, version) → RuntimeSpec. 버전 불변. "latest" 는 semver/등록순 최신.
// 하니스·데이터셋·judge 와 동일한 소유 모델: 테넌트 소유 우선, 없으면 SHARED_TENANT(first-party 공용 런타임) 폴백.
// 테넌트가 자기 실행 인프라(local/nomad/k8s)를 직접 등록·버전관리한다. async — Postgres 도 같은 계약.
// list() 한 항목 — 버전 요약 + 버전 태그(태그 있는 버전만).
export interface RuntimeListEntry {
  id: string;
  versions: string[];
  owner: string;
  versionTags?: Record<string, string[]>; // 버전 → 자유 라벨 — 가변 레지스트리 메타(스펙 밖)
}

export interface RuntimeRegistry {
  register(tenant: string, spec: RuntimeSpec): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<RuntimeSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  ownVersions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<RuntimeListEntry[]>;
  // 버전 태그(자유 라벨, 전체 교체) — 가변 레지스트리 메타(스펙 불변성 밖). 테넌트 소유 버전만; _shared 는 NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // 버전 → 태그 맵(태그 있는 버전만). 읽기는 versions() 와 동일하게 owner 해석(_shared 폴백 포함).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}

interface Entry {
  spec: RuntimeSpec;
  seq: number;
  tags?: string[]; // 버전 태그 — 가변 레지스트리 메타(스펙 불변성 밖)
}

export class InMemoryRuntimeRegistry implements RuntimeRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
  private seq = 0;

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .sort((a, b) => compareVersions(a.spec.version, b.spec.version) || a.seq - b.seq)
      .map((e) => e.spec.version);
  }
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.byOwner.get(tenant)?.has(id)) return tenant;
    if (this.byOwner.get(SHARED_TENANT)?.has(id)) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, spec: RuntimeSpec): Promise<void> {
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(spec.id);
    if (!versions) {
      versions = new Map();
      ids.set(spec.id, versions);
    }
    const existing = versions.get(spec.version);
    if (existing) {
      if (!specsEqual(existing.spec, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: spec.id, version: spec.version },
          `runtime ${spec.id}@${spec.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    versions.set(spec.version, { spec, seq: this.seq++ });
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = this.ownerOf(tenant, id);
    return owner ? (this.byOwner.get(owner)?.get(id)?.has(version) ?? false) : false;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<RuntimeSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `runtime '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<RuntimeListEntry[]> {
    const ids = new Map<string, string>();
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    const out: RuntimeListEntry[] = [];
    for (const [id, owner] of [...ids.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const versionTags = await this.versionTags(owner, id);
      out.push({
        id,
        owner,
        versions: this.ownerVersions(owner, id),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }

  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version); // 직접 소유만(폴백 없음 — _shared 는 못 태깅)
    if (!entry) throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `runtime ${id}@${version} 가 없습니다.`);
    entry.tags = tags.length > 0 ? tags : undefined; // 빈 배열 = 제거(revive 의 deletedAt=undefined 와 동일 관용)
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, string[]> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.tags !== undefined && e.tags.length > 0) out[e.spec.version] = e.tags;
    }
    return out;
  }
}
