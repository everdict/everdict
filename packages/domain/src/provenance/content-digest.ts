import { BadRequestError } from "@everdict/contracts";

// Content digest over the canonical (key-sorted, undefined-stripped) JSON of a document — a stable,
// dependency-free identity stamp for provenance (verdict policies, dataset case bundles, resolved harness
// specs). FNV-1a 64-bit: this is IDENTITY, not a security boundary — collisions are constructible, so a
// digest match answers "is this the same document?" against honest data, never "was this tampered with?"
// against an adversary with write access (the write barriers are the admin-gated submit paths). Digests
// answer "was it EXACTLY this
// document?" long after the registry row has moved on.
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentDigest(value: unknown): string {
  // `undefined` is not a document — JSON.stringify(undefined) returns the VALUE undefined (typed string),
  // so canonicalize would hand back a non-string and .length below would throw a bare TypeError far from the
  // caller. Refuse it here, typed and named. (Inside objects, undefined values are stripped — that is shape
  // canonicalization; a top-level undefined is a caller bug.)
  if (value === undefined)
    throw new BadRequestError("BAD_REQUEST", {}, "contentDigest expects a JSON-serializable document, got undefined.");
  const text = canonicalize(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
