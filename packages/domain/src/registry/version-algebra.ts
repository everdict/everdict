import { NotFoundError } from "@everdict/contracts";

// Version algebra — the rules every versioned registry (harness/dataset/judge/runtime/rubric/…)
// shares: semver ordering, latest resolution, and key-order-independent content identity (the basis
// of version immutability). Store impls (VersionedStore/Pg*) live in @everdict/registry.

export const LATEST = "latest";
// Owner of first-party/shared entities. If a tenant doesn't have its own, resolution falls back here.
export const SHARED_TENANT = "_shared";

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

export function resolveRef(id: string, ref: string, sorted: string[]): string {
  if (sorted.length === 0) throw new NotFoundError("NOT_FOUND", { id }, `Harness '${id}' not found.`);
  if (ref === LATEST) return sorted[sorted.length - 1] as string;
  if (!sorted.includes(ref))
    throw new NotFoundError("NOT_FOUND", { id, version: ref }, `Harness ${id}@${ref} not found.`);
  return ref;
}
