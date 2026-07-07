import { BadRequestError, type HarnessSpec, NotFoundError, type ServiceHarnessSpec } from "@everdict/core";

export const LATEST = "latest";
// Owner of first-party/shared harnesses. If a tenant doesn't have its own, resolution falls back here.
export const SHARED_TENANT = "_shared";

// Shared harness-version utilities (_shared fallback + semver/latest + immutable comparison + service narrowing).
// Shared by the taxonomy registries (VersionedStore/PgVersionedStore + HarnessTemplate/Instance registries). The flat HarnessRegistry has been removed.

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

// Key-order-independent comparison (Postgres jsonb does not preserve key order).
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

// Pg `tags jsonb` column → string[] (version tags). jsonb can hold arbitrary values, so defensively keep only strings.
export function parseVersionTags(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

export function resolveRef(id: string, ref: string, sorted: string[]): string {
  if (sorted.length === 0) throw new NotFoundError("NOT_FOUND", { id }, `Harness '${id}' not found.`);
  if (ref === LATEST) return sorted[sorted.length - 1] as string;
  if (!sorted.includes(ref))
    throw new NotFoundError("NOT_FOUND", { id, version: ref }, `Harness ${id}@${ref} not found.`);
  return ref;
}

export function asService(spec: HarnessSpec, id: string): ServiceHarnessSpec {
  if (spec.kind !== "service") {
    throw new BadRequestError("BAD_REQUEST", { id, version: spec.version }, `Harness ${id} is not a service.`);
  }
  return spec;
}
