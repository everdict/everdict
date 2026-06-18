import { ConflictError, type Dataset, NotFoundError } from "@assay/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// 데이터셋 버전 SSOT — (tenant, id, version) → Dataset. 버전 불변. "latest" 는 semver/등록순 최신.
// 하니스 레지스트리와 동일한 소유 모델: 테넌트 소유 우선, 없으면 SHARED_TENANT(first-party 벤치마크) 폴백.
// 하니스 무관 — 같은 데이터셋을 여러 하니스@버전으로 돌려 baseline 비교한다. async — Postgres 도 같은 계약.
export interface DatasetRegistry {
  register(tenant: string, dataset: Dataset): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<Dataset>;
  versions(tenant: string, id: string): Promise<string[]>; // 정렬됨(semver 우선) — 소유 우선/_shared 폴백
  ownVersions(tenant: string, id: string): Promise<string[]>; // 이 테넌트가 직접 등록한 버전만(폴백 없음 — 충돌 판정용)
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

interface Entry {
  dataset: Dataset;
  seq: number;
}

export class InMemoryDatasetRegistry implements DatasetRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
  private seq = 0;

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .sort((a, b) => compareVersions(a.dataset.version, b.dataset.version) || a.seq - b.seq)
      .map((e) => e.dataset.version);
  }
  // 해석 소유자: 테넌트가 id 를 가졌으면 테넌트, 아니면 SHARED(있으면), 아니면 undefined.
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.byOwner.get(tenant)?.has(id)) return tenant;
    if (this.byOwner.get(SHARED_TENANT)?.has(id)) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, dataset: Dataset): Promise<void> {
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(dataset.id);
    if (!versions) {
      versions = new Map();
      ids.set(dataset.id, versions);
    }
    const existing = versions.get(dataset.version);
    if (existing) {
      if (!specsEqual(existing.dataset, dataset)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: dataset.id, version: dataset.version },
          `데이터셋 ${dataset.id}@${dataset.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    versions.set(dataset.version, { dataset, seq: this.seq++ });
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

  async get(tenant: string, id: string, ref = "latest"): Promise<Dataset> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `데이터셋 '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).dataset;
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
