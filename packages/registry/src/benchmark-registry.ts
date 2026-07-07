import { ConflictError, NotFoundError } from "@everdict/core";
import type { BenchmarkAdapterSpec } from "@everdict/datasets";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// 벤치마크 정의(레시피) SSOT — (tenant, id, version) → BenchmarkAdapterSpec(데이터). 버전 불변.
// 데이터셋/하니스/judge 와 동일한 소유 모델: 테넌트 소유 우선, 없으면 _shared(first-party) 폴백.
// 이게 "유저별/테넌트별 벤치마크" 일반화의 핵심 — 카탈로그(코드)를 테넌트가 등록하는 데이터로.
export interface BenchmarkRegistry {
  register(tenant: string, spec: BenchmarkAdapterSpec): Promise<void>;
  get(tenant: string, id: string, ref?: string): Promise<BenchmarkAdapterSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // 소유 우선/_shared 폴백
  ownVersions(tenant: string, id: string): Promise<string[]>; // 이 테넌트 소유만(충돌 판정)
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

interface Entry {
  spec: BenchmarkAdapterSpec;
  seq: number;
}

export class InMemoryBenchmarkRegistry implements BenchmarkRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>();
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

  async register(tenant: string, spec: BenchmarkAdapterSpec): Promise<void> {
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
          `벤치마크 ${spec.id}@${spec.version} 가 다른 내용으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    versions.set(spec.version, { spec, seq: this.seq++ });
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<BenchmarkAdapterSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `벤치마크 '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const ids = new Map<string, string>();
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    return [...ids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, owner]) => ({ id, owner, versions: this.ownerVersions(owner, id) }));
  }
}
