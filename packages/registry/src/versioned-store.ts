import { ConflictError, NotFoundError } from "@assay/core";
import { LATEST, SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// (tenant, id, version) → T 의 공통 in-memory 저장/해석: _shared 폴백, latest/semver, 버전 불변.
// 하네스 taxonomy 레지스트리(템플릿/인스턴스)가 공유한다 — 기존 HarnessRegistry 의 머신을 일반화한 것.
interface Entry<T> {
  item: T;
  seq: number;
  createdAt: string; // 등록 시각(ISO)
  createdBy?: string; // 등록한 subject(없으면 시드/파일)
  deletedAt?: number; // 소프트 삭제 tombstone — set 되면 모든 read 에서 제외(내용은 보존, 데이터셋과 동일 패턴)
}

// 목록 메타 — 한 id 의 살아있는 버전 요약(등록 이력에서). category/kind 등 스펙 파생은 상위 레지스트리가 채운다.
export interface VersionMeta {
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  createdBy?: string; // 최초 등록 버전의 subject
  createdAt?: string; // 최초 등록 시각(ISO)
  updatedAt?: string; // 최근 등록 시각(ISO)
}

export class VersionedStore<T extends { id: string; version: string }> {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry<T>>>>(); // tenant → id → version → Entry
  private seq = 0;
  constructor(private readonly label: string) {}

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .filter((e) => e.deletedAt === undefined) // tombstone 제외 — 삭제된 버전은 모든 read 에서 안 보인다
      .sort((a, b) => compareVersions(a.item.version, b.item.version) || a.seq - b.seq)
      .map((e) => e.item.version);
  }
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.ownerVersions(tenant, id).length > 0) return tenant;
    if (this.ownerVersions(SHARED_TENANT, id).length > 0) return SHARED_TENANT;
    return undefined;
  }

  register(tenant: string, item: T, createdBy?: string): void {
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(item.id);
    if (!versions) {
      versions = new Map();
      ids.set(item.id, versions);
    }
    const existing = versions.get(item.version);
    if (existing) {
      if (!specsEqual(existing.item, item)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: item.id, version: item.version },
          `${this.label} ${item.id}@${item.version} 가 다른 스펙으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      existing.deletedAt = undefined; // 동일 내용 재등록 = 부활(revive) — 내용 불변은 그대로
      return;
    }
    versions.set(item.version, {
      item,
      seq: this.seq++,
      createdAt: new Date().toISOString(),
      ...(createdBy !== undefined ? { createdBy } : {}),
    });
  }

  has(tenant: string, id: string, version: string): boolean {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id).includes(version) : false;
  }

  // 테넌트 직접 소유 + 살아있는 버전만(폴백 없음 — _shared 는 못 지운다). 없으면 NotFound. 데이터셋과 동일 패턴.
  private ownLiveEntry(tenant: string, id: string, version: string): Entry<T> {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version);
    if (!entry || entry.deletedAt !== undefined)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `${this.label} ${id}@${version} 가 없습니다.`);
    return entry;
  }

  creatorOfVersion(tenant: string, id: string, version: string): string | undefined {
    return this.ownLiveEntry(tenant, id, version).createdBy;
  }

  softDelete(tenant: string, id: string, version: string): void {
    this.ownLiveEntry(tenant, id, version).deletedAt = Date.now();
  }

  versions(tenant: string, id: string): string[] {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  ownVersions(tenant: string, id: string): string[] {
    return this.ownerVersions(tenant, id); // 폴백 없음 — 충돌 판정용
  }

  get(tenant: string, id: string, ref: string = LATEST): T {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `${this.label} '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry<T>).item;
  }

  listIds(tenant: string): Array<{ id: string; versions: string[]; owner: string }> {
    const ids = new Map<string, string>(); // id → owner (테넌트 우선)
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    return [...ids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, owner]) => ({ id, owner, versions: this.ownerVersions(owner, id) }));
  }

  // 목록 메타 — id 별 버전 요약 + 등록 이력(최초 subject/시각, 최근 시각). 상위 레지스트리가 스펙 파생(category 등)을 얹는다.
  listMeta(tenant: string): VersionMeta[] {
    const out: VersionMeta[] = [];
    for (const { id, owner } of this.listIds(tenant)) {
      const versions = this.ownerVersions(owner, id);
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue; // 버전 없는 id는 방어적으로 제외
      const entries = [...(this.byOwner.get(owner)?.get(id)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
      const earliest = entries[0];
      const latest = entries.at(-1);
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(earliest?.createdBy !== undefined ? { createdBy: earliest.createdBy } : {}),
        ...(earliest ? { createdAt: earliest.createdAt } : {}),
        ...(latest ? { updatedAt: latest.createdAt } : {}),
      });
    }
    return out;
  }
}
