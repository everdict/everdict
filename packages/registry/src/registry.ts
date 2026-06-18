import { BadRequestError, ConflictError, type HarnessSpec, NotFoundError, type ServiceHarnessSpec } from "@assay/core";

export const LATEST = "latest";

// 하니스 버전 SSOT — (id, version) → HarnessSpec 해석. 버전은 불변(immutable): 같은 (id,version) 을
// 다른 스펙으로 다시 등록하면 충돌. "latest" 는 semver(가능하면) 또는 등록순으로 최신을 가리킨다.
export interface HarnessRegistry {
  register(spec: HarnessSpec): void;
  has(id: string, version: string): boolean;
  get(id: string, ref?: string): HarnessSpec; // ref = 정확한 버전 또는 "latest"(기본)
  getService(id: string, ref?: string): ServiceHarnessSpec; // service 로 좁힘
  versions(id: string): string[]; // 정렬됨(semver 우선)
  list(): Array<{ id: string; versions: string[] }>;
}

// "1.2.3" → [1,2,3]. semver 가 아니면 undefined.
function parseSemver(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (sa && sb) {
    for (let i = 0; i < 3; i++) {
      const d = (sa[i] ?? 0) - (sb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  return 0; // semver 아님 → 등록순 유지(안정 정렬)
}

interface Entry {
  spec: HarnessSpec;
  seq: number; // 등록 순서(semver 아닐 때 latest 판단)
}

export class InMemoryHarnessRegistry implements HarnessRegistry {
  private readonly byId = new Map<string, Map<string, Entry>>();
  private seq = 0;

  register(spec: HarnessSpec): void {
    let versions = this.byId.get(spec.id);
    if (!versions) {
      versions = new Map();
      this.byId.set(spec.id, versions);
    }
    const existing = versions.get(spec.version);
    if (existing) {
      // 불변성: 동일 스펙이면 멱등, 다르면 충돌(드리프트 방지).
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec)) {
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

  has(id: string, version: string): boolean {
    return this.byId.get(id)?.has(version) ?? false;
  }

  versions(id: string): string[] {
    const versions = this.byId.get(id);
    if (!versions) return [];
    return [...versions.values()]
      .sort((a, b) => compareVersions(a.spec.version, b.spec.version) || a.seq - b.seq)
      .map((e) => e.spec.version);
  }

  private resolveVersion(id: string, ref: string): string {
    const versions = this.byId.get(id);
    if (!versions || versions.size === 0) {
      throw new NotFoundError("NOT_FOUND", { id }, `하니스 '${id}' 가 레지스트리에 없습니다.`);
    }
    if (ref === LATEST) {
      const sorted = this.versions(id);
      const last = sorted[sorted.length - 1];
      if (!last) throw new NotFoundError("NOT_FOUND", { id }, `하니스 '${id}' 버전이 없습니다.`);
      return last;
    }
    if (!versions.has(ref)) {
      throw new NotFoundError("NOT_FOUND", { id, version: ref }, `하니스 ${id}@${ref} 가 없습니다.`);
    }
    return ref;
  }

  get(id: string, ref: string = LATEST): HarnessSpec {
    const version = this.resolveVersion(id, ref);
    // resolveVersion 통과 → 반드시 존재.
    return (this.byId.get(id)?.get(version) as Entry).spec;
  }

  getService(id: string, ref: string = LATEST): ServiceHarnessSpec {
    const spec = this.get(id, ref);
    if (spec.kind !== "service") {
      throw new BadRequestError("BAD_REQUEST", { id, version: spec.version }, `하니스 ${id} 는 service 가 아닙니다.`);
    }
    return spec;
  }

  list(): Array<{ id: string; versions: string[] }> {
    return [...this.byId.keys()].sort().map((id) => ({ id, versions: this.versions(id) }));
  }
}
