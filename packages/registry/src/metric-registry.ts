import { ConflictError, type MetricSpec, NotFoundError } from "@assay/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// Metric 버전 SSOT — (tenant, id, version) → MetricSpec. 버전 불변. "latest" 는 semver/등록순 최신.
// 하니스/judge 와 동일한 소유 모델: 테넌트 소유 우선, 없으면 SHARED_TENANT(first-party 기본 메트릭) 폴백.
// 유저가 자기 메트릭(threshold 등 합격규칙)을 직접 등록·버전관리한다. async — Postgres 도 같은 계약.
export interface MetricRegistry {
  register(tenant: string, spec: MetricSpec): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<MetricSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // 정렬됨(semver 우선) — 소유 우선/_shared 폴백
  ownVersions(tenant: string, id: string): Promise<string[]>; // 이 테넌트가 직접 등록한 버전만(폴백 없음 — 충돌 판정용)
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

interface Entry {
  spec: MetricSpec;
  seq: number;
}

export class InMemoryMetricRegistry implements MetricRegistry {
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

  async register(tenant: string, spec: MetricSpec): Promise<void> {
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
          `metric ${spec.id}@${spec.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
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
    return this.ownerVersions(tenant, id); // 정확히 이 테넌트 소유만(폴백 없음)
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<MetricSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `metric '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const ids = new Map<string, string>(); // id → owner (테넌트 우선)
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    return [...ids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, owner]) => ({ id, owner, versions: this.ownerVersions(owner, id) }));
  }
}
