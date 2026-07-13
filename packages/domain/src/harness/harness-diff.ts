import type { HarnessFieldChange, HarnessSpec, HarnessSpecDiff } from "@everdict/contracts";

// Top-level keys excluded from the diff — id is identical by construction, version differs trivially between two versions.
const IGNORED_TOP_LEVEL = new Set(["id", "version"]);

// Distinguishes "key absent on one side" from "key present with an undefined value" so we can label added vs removed vs changed.
const MISSING = Symbol("missing");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Key-sorted canonicalization — stable equality regardless of object key order / avoids false changes. undefined has a sentinel.
function canonical(v: unknown): string {
  if (v === undefined) return "@@undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

// Display string — strings as-is, others (objects/arrays/numbers/booleans) as JSON, "(none)" if absent.
function repr(v: unknown): string {
  if (v === undefined) return "(none)";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// An array whose every element is an object with a stable string `name` (services) → reconcile by name.
// Anything else (string arrays, object arrays without a name like dependencies) returns undefined → leaf-compared as a whole.
function nameKeyed(v: unknown): Map<string, unknown> | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  if (!v.every((el) => isPlainObject(el) && typeof el.name === "string")) return undefined;
  return new Map(v.map((el) => [(el as { name: string }).name, el] as const));
}

// Recursive walk collecting leaf changes. `before`/`after` are MISSING when the key exists on only one side.
function walk(path: string, before: unknown, after: unknown, out: HarnessFieldChange[]): void {
  const b = before === MISSING ? undefined : before;
  const a = after === MISSING ? undefined : after;
  if (canonical(b) === canonical(a)) return;

  // Both name-keyed arrays (services) — reconcile by name so a single service's changed field surfaces at services[<name>].<field>.
  const bMap = nameKeyed(b);
  const aMap = nameKeyed(a);
  if (bMap && aMap) {
    for (const name of new Set([...bMap.keys(), ...aMap.keys()])) {
      walk(
        `${path}[${name}]`,
        bMap.has(name) ? bMap.get(name) : MISSING,
        aMap.has(name) ? aMap.get(name) : MISSING,
        out,
      );
    }
    return;
  }

  // Both plain objects — recurse into the key union (env/params/target/frontDoor/… → env.MODEL, frontDoor.submit, …).
  if (isPlainObject(b) && isPlainObject(a)) {
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      walk(path ? `${path}.${key}` : key, key in b ? b[key] : MISSING, key in a ? a[key] : MISSING, out);
    }
    return;
  }

  // Leaf change (scalar / non-name-keyed array / an object↔scalar shape change).
  const change: HarnessFieldChange["change"] = before === MISSING ? "added" : after === MISSING ? "removed" : "changed";
  out.push({ path, before: repr(b), after: repr(a), change });
}

// base ↔ candidate resolved-harness-spec diff. Reports leaf field changes by path (services keyed by name),
// excluding the trivially-differing id/version keys. Sorted by path for stable, reproducible output.
export function diffHarnessSpecs(base: HarnessSpec, candidate: HarnessSpec): HarnessSpecDiff {
  const changes: HarnessFieldChange[] = [];
  const baseRec = base as Record<string, unknown>;
  const candRec = candidate as Record<string, unknown>;
  const keys = new Set([...Object.keys(baseRec), ...Object.keys(candRec)].filter((k) => !IGNORED_TOP_LEVEL.has(k)));
  for (const key of keys) {
    walk(key, key in baseRec ? baseRec[key] : MISSING, key in candRec ? candRec[key] : MISSING, changes);
  }
  changes.sort((x, y) => x.path.localeCompare(y.path));
  return {
    id: candidate.id,
    base: base.version,
    candidate: candidate.version,
    kindChanged: base.kind !== candidate.kind,
    changes,
    summary: {
      added: changes.filter((c) => c.change === "added").length,
      removed: changes.filter((c) => c.change === "removed").length,
      changed: changes.filter((c) => c.change === "changed").length,
    },
  };
}
