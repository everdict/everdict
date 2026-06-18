import { BadRequestError, ConflictError, type HarnessSpec, NotFoundError, type ServiceHarnessSpec } from "@assay/core";

export const LATEST = "latest";

// 하니스 버전 SSOT — (id, version) → HarnessSpec 해석. 버전은 불변(immutable). "latest" 는 semver(가능하면)
// 또는 등록순으로 최신. async 인터페이스 — Postgres 등 영속 백엔드도 같은 계약으로 구현된다.
export interface HarnessRegistry {
  register(spec: HarnessSpec): Promise<void>;
  has(id: string, version: string): Promise<boolean>;
  get(id: string, ref?: string): Promise<HarnessSpec>; // ref = 정확한 버전 또는 "latest"(기본)
  getService(id: string, ref?: string): Promise<ServiceHarnessSpec>; // service 로 좁힘
  versions(id: string): Promise<string[]>; // 정렬됨(semver 우선)
  list(): Promise<Array<{ id: string; versions: string[] }>>;
}

// "1.2.3" → [1,2,3]. semver 가 아니면 undefined.
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
  return 0; // semver 아님 → 안정 정렬(호출부가 등록순 tie-break)
}

// semver 우선 정렬(가장 오래된 → 최신). latest = 마지막.
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}

// 키 순서 무관 비교 — Postgres jsonb 는 키 순서를 보존하지 않으므로 안정 직렬화로 비교한다.
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

// ref 를 정확한 버전으로 해석 (sorted 는 versions(id) 결과). 순수.
export function resolveRef(id: string, ref: string, sorted: string[]): string {
  if (sorted.length === 0) throw new NotFoundError("NOT_FOUND", { id }, `하니스 '${id}' 가 레지스트리에 없습니다.`);
  if (ref === LATEST) {
    const last = sorted[sorted.length - 1];
    if (!last) throw new NotFoundError("NOT_FOUND", { id }, `하니스 '${id}' 버전이 없습니다.`);
    return last;
  }
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
  seq: number; // 등록 순서(semver 아닐 때 latest 판단)
}

export class InMemoryHarnessRegistry implements HarnessRegistry {
  private readonly byId = new Map<string, Map<string, Entry>>();
  private seq = 0;

  async register(spec: HarnessSpec): Promise<void> {
    let versions = this.byId.get(spec.id);
    if (!versions) {
      versions = new Map();
      this.byId.set(spec.id, versions);
    }
    const existing = versions.get(spec.version);
    if (existing) {
      // 불변성: 동일 스펙이면 멱등, 다르면 충돌(드리프트 방지).
      if (!specsEqual(existing.spec, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { id: spec.id, version: spec.version },
          `하니스 ${spec.id}@${spec.version} 가 다른 스펙으로 이미 등록되어 있습니다(버전은 불변).`,
        );
      }
      return;
    }
    versions.set(spec.version, { spec, seq: this.seq++ });
  }

  async has(id: string, version: string): Promise<boolean> {
    return this.byId.get(id)?.has(version) ?? false;
  }

  async versions(id: string): Promise<string[]> {
    const versions = this.byId.get(id);
    if (!versions) return [];
    return [...versions.values()]
      .sort((a, b) => compareVersions(a.spec.version, b.spec.version) || a.seq - b.seq)
      .map((e) => e.spec.version);
  }

  async get(id: string, ref: string = LATEST): Promise<HarnessSpec> {
    const version = resolveRef(id, ref, await this.versions(id));
    return (this.byId.get(id)?.get(version) as Entry).spec;
  }

  async getService(id: string, ref: string = LATEST): Promise<ServiceHarnessSpec> {
    return asService(await this.get(id, ref), id);
  }

  async list(): Promise<Array<{ id: string; versions: string[] }>> {
    const out: Array<{ id: string; versions: string[] }> = [];
    for (const id of [...this.byId.keys()].sort()) out.push({ id, versions: await this.versions(id) });
    return out;
  }
}
