import { createHash } from "node:crypto";
import { BadRequestError } from "@everdict/contracts";

// Content digest over the canonical (key-sorted, undefined-stripped) JSON of a document — a stable identity
// stamp for provenance (verdict policies, dataset case bundles, resolved harness specs). Digests answer "was
// it EXACTLY this document?" long after the registry row has moved on.
//
// Two algorithms, one canonical form. New stamps are SHA-256 (`sha256:<64 hex>`) — collision-resistant, so a
// match is evidence about the document and not merely about honest data. Stamps written before this lived is
// FNV-1a 64-bit (bare 16 hex), which is an IDENTITY hash only: collisions are constructible, so a legacy
// match answers "is this the same document?" against honest data, never "was this tampered with?" against an
// adversary with write access. Legacy stamps are still VERIFIED (dual-read, `digestsMatch`) rather than
// invalidated — history has to keep verifying — so the identity-only caveat survives exactly as long as those
// rows do. Under either algorithm the write barriers are the admin-gated submit paths.
const SHA256_PREFIX = "sha256:";
const LEGACY_FNV_PATTERN = /^[0-9a-f]{16}$/;

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

// The canonical text both algorithms hash — the SAME bytes, so a document's legacy and sha256 stamps describe
// the same canonicalization and a dual-read verification compares like with like.
//
// Callers stamp the SCHEMA-PARSED document, never a raw jsonb row: canonicalization normalizes shape (key
// order, absent keys) but not semantics, so a value a schema would rewrite must be rewritten before it is
// hashed. No digest input carries `Score` rows today (the subjects are dataset case bundles, resolved harness
// and judge specs, grading plans and policy documents), so the read-time score normalizer never moves a byte
// under a stamp — a manifest subject that later embeds scores must digest the parsed form.
function canonicalText(value: unknown): string {
  // `undefined` is not a document — JSON.stringify(undefined) returns the VALUE undefined (typed string), so
  // canonicalize would hand back a non-string far from the caller. Refuse it here, typed and named. (Inside
  // objects, undefined values are stripped — that is shape canonicalization; a top-level undefined is a
  // caller bug.)
  if (value === undefined)
    throw new BadRequestError("BAD_REQUEST", {}, "contentDigest expects a JSON-serializable document, got undefined.");
  return canonicalize(value);
}

export function contentDigest(value: unknown): string {
  return `${SHA256_PREFIX}${createHash("sha256").update(canonicalText(value), "utf8").digest("hex")}`;
}

// The pre-sha256 algorithm, kept for verification only — nothing stamps FNV any more.
function legacyFnvDigest(value: unknown): string {
  const text = canonicalText(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

// A document's digest in the SAME algorithm as an existing stamp — what a verification displays beside the
// stamp it is checking, so "stored" and "current" stay comparable on a legacy row instead of reading as a
// mismatch that is only an algorithm change. An unrecognized stamp format falls through to sha256, which can
// never equal it: fail closed, never guess the algorithm.
export function digestUnder(stamped: string, document: unknown): string {
  return LEGACY_FNV_PATTERN.test(stamped) ? legacyFnvDigest(document) : contentDigest(document);
}

// The ONE way to compare a stamped digest against a document. The algorithm is read off the STAMP, so a
// record sealed before sha256 keeps verifying against its own document forever while every new seal is
// sha256 — a `contentDigest(doc) === stamped` comparison would instead fail every legacy row closed, which
// for a fail-closed reader (resolvePolicyResolution) silently erases the history it was written to protect.
export function digestsMatch(stamped: string, document: unknown): boolean {
  return digestUnder(stamped, document) === stamped;
}

// The hex payload of a digest without its algorithm prefix — for the places that need a SHORT content
// identity to NAME a document (a composed policy's version), not a stamp to compare.
export function digestHex(digest: string): string {
  return digest.startsWith(SHA256_PREFIX) ? digest.slice(SHA256_PREFIX.length) : digest;
}
