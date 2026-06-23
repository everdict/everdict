import { BadRequestError, type HarnessSpec, NotFoundError, type ServiceHarnessSpec } from "@assay/core";

export const LATEST = "latest";
// first-party/공유 하니스의 소유자. 테넌트가 자기 것을 안 가졌으면 여기로 폴백한다.
export const SHARED_TENANT = "_shared";

// 하네스 버전 공통 유틸(_shared 폴백 + semver/latest + 불변 비교 + service narrowing). taxonomy 레지스트리
// (VersionedStore/PgVersionedStore + HarnessTemplate/Instance 레지스트리)가 공유한다. 평면 HarnessRegistry 는 제거됨.

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
