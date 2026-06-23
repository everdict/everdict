import { ConflictError, type Dataset, NotFoundError } from "@assay/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// 데이터셋 버전 SSOT — (tenant, id, version) → Dataset. 버전 불변. "latest" 는 semver/등록순 최신.
// 하니스 레지스트리와 동일한 소유 모델: 테넌트 소유 우선, 없으면 SHARED_TENANT(first-party 벤치마크) 폴백.
// 하니스 무관 — 같은 데이터셋을 여러 하니스@버전으로 돌려 baseline 비교한다. async — Postgres 도 같은 계약.
export interface DatasetRegistry {
  // createdBy: 이 버전을 등록한 subject(소프트 삭제 권한 판정용 — 생성자 본인). 시스템 시드/파일 로더는 없음(undefined).
  register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<Dataset>;
  versions(tenant: string, id: string): Promise<string[]>; // 정렬됨(semver 우선) — 소유 우선/_shared 폴백, 삭제된 버전 제외
  ownVersions(tenant: string, id: string): Promise<string[]>; // 이 테넌트가 직접 등록한 버전만(폴백 없음 — 충돌 판정용), 삭제된 버전 제외
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
  // 이 테넌트가 직접 소유한 살아있는 버전의 생성자 subject(없으면 undefined). 없는/삭제된/비소유 버전은 NotFound — 폴백 없음.
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined>;
  // 소프트 삭제(tombstone) — 데이터는 보존하되 read 에서 제외(재현성 유지). 이 테넌트 직접 소유만; 없는/이미 삭제된 버전은 NotFound.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
}

interface Entry {
  dataset: Dataset;
  seq: number;
  createdBy?: string;
  deletedAt?: number; // tombstone — set 되면 모든 read 에서 제외(데이터는 보존)
}

export class InMemoryDatasetRegistry implements DatasetRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
  private seq = 0;

  // 살아있는(삭제 안 된) 버전만 — 정렬됨. 모든 공개 read 의 기반.
  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .filter((e) => e.deletedAt === undefined)
      .sort((a, b) => compareVersions(a.dataset.version, b.dataset.version) || a.seq - b.seq)
      .map((e) => e.dataset.version);
  }
  // 해석 소유자: 테넌트가 id 의 살아있는 버전을 가졌으면 테넌트, 아니면 SHARED(있으면), 아니면 undefined.
  // (모든 버전이 tombstone 이면 그 id 는 없는 것으로 취급 — read/resolve 에서 사라진다.)
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.ownerVersions(tenant, id).length > 0) return tenant;
    if (this.ownerVersions(SHARED_TENANT, id).length > 0) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void> {
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
    const existing = versions.get(dataset.version); // raw — tombstone 된 슬롯도 본다(버전 identity 는 불변).
    if (existing) {
      if (!specsEqual(existing.dataset, dataset)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: dataset.id, version: dataset.version },
          `데이터셋 ${dataset.id}@${dataset.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      if (existing.deletedAt !== undefined) existing.deletedAt = undefined; // 같은 내용 재등록 → 되살림(revive)
      return;
    }
    versions.set(dataset.version, { dataset, seq: this.seq++, ...(createdBy !== undefined ? { createdBy } : {}) });
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id).includes(version) : false;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // 정확히 이 테넌트 소유만(폴백 없음), 살아있는 버전만
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<Dataset> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `데이터셋 '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).dataset;
  }

  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const ids = new Map<string, string>(); // id → owner (테넌트 우선); 살아있는 버전이 하나라도 있는 id 만.
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? [])
      if (this.ownerVersions(SHARED_TENANT, id).length > 0) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? [])
      if (this.ownerVersions(tenant, id).length > 0) ids.set(id, tenant);
    return [...ids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, owner]) => ({ id, owner, versions: this.ownerVersions(owner, id) }));
  }

  // 이 테넌트가 직접 소유한 살아있는 버전만(폴백 없음 — _shared 는 못 지운다). 없으면 NotFound.
  private ownLiveEntry(tenant: string, id: string, version: string): Entry {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version);
    if (!entry || entry.deletedAt !== undefined)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `데이터셋 ${id}@${version} 가 없습니다.`);
    return entry;
  }

  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.ownLiveEntry(tenant, id, version).createdBy;
  }

  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    this.ownLiveEntry(tenant, id, version).deletedAt = Date.now();
  }
}
