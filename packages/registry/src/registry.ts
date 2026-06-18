import { BadRequestError, ConflictError, type HarnessSpec, NotFoundError, type ServiceHarnessSpec } from "@assay/core";

export const LATEST = "latest";
// first-party/공유 하니스의 소유자. 테넌트가 자기 것을 안 가졌으면 여기로 폴백한다.
export const SHARED_TENANT = "_shared";

// 하니스 버전 SSOT — (tenant, id, version) → HarnessSpec. 버전 불변. "latest" 는 semver(가능하면)/등록순 최신.
// 해석은 테넌트 소유 우선, 없으면 SHARED_TENANT(first-party) 폴백. async — Postgres 백엔드도 같은 계약.
export interface HarnessRegistry {
  register(tenant: string, spec: HarnessSpec): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessSpec>;
  getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // 정렬됨(semver 우선) — 소유 우선/_shared 폴백
  ownVersions(tenant: string, id: string): Promise<string[]>; // 이 테넌트가 직접 등록한 버전만(폴백 없음 — 충돌 판정용)
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

function parseSemver(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (sa && sb) {
    for (let i = 0; i < 3; i++) {
      const d = (sa[i] ?? 0) - (sb[i] ?? 0);
      if (d !== 0) return d;
    }
  }
  return 0;
}
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}

// 키 순서 무관 비교 (Postgres jsonb 는 키 순서 미보존).
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
export function specsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function resolveRef(id: string, ref: string, sorted: string[]): string {
  if (sorted.length === 0) throw new NotFoundError("NOT_FOUND", { id }, `하니스 '${id}' 가 없습니다.`);
  if (ref === LATEST) return sorted[sorted.length - 1] as string;
  if (!sorted.includes(ref))
    throw new NotFoundError("NOT_FOUND", { id, version: ref }, `하니스 ${id}@${ref} 가 없습니다.`);
  return ref;
}

export function asService(spec: HarnessSpec, id: string): ServiceHarnessSpec {
  if (spec.kind !== "service") {
    throw new BadRequestError("BAD_REQUEST", { id, version: spec.version }, `하니스 ${id} 는 service 가 아닙니다.`);
  }
  return spec;
}

interface Entry {
  spec: HarnessSpec;
  seq: number;
}

export class InMemoryHarnessRegistry implements HarnessRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
  private seq = 0;

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .sort((a, b) => compareVersions(a.spec.version, b.spec.version) || a.seq - b.seq)
      .map((e) => e.spec.version);
  }
  // 해석 소유자: 테넌트가 id 를 가졌으면 테넌트, 아니면 SHARED(있으면), 아니면 undefined.
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.byOwner.get(tenant)?.has(id)) return tenant;
    if (this.byOwner.get(SHARED_TENANT)?.has(id)) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, spec: HarnessSpec): Promise<void> {
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
          `하니스 ${spec.id}@${spec.version} 가 다른 스펙으로 이미 등록되어 있습니다(버전은 불변).`,
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

  async get(tenant: string, id: string, ref: string = LATEST): Promise<HarnessSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `하니스 '${id}' 가 없습니다.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async getService(tenant: string, id: string, ref: string = LATEST): Promise<ServiceHarnessSpec> {
    return asService(await this.get(tenant, id, ref), id);
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
