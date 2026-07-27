import type { NodeRef, Predicate, SourceKind } from "@everdict/contracts";

// Deterministic id derivation for the knowledge graph — the pure kernel piece contracts deliberately left out (a
// schema field, not logic). Kept here so every harvester/extractor derives the SAME id for the same input, which is
// what makes harvest idempotent (re-running writes the same rows) and append-only re-extraction stable.

// The field separator for hashed ids. A printable delimiter (not a control char) that structured id/type/source parts
// do not contain — so distinct part tuples map to distinct hash inputs.
const SEP = "|";

// A well-distributed 53-bit string hash (cyrb53) rendered as hex — dependency-free and pure (no crypto import, no
// clock). Used for mention/edge ids, whose parts include free-form surface text that must not be split on a delimiter.
function cyrb53(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

// A content-addressed, human-readable node id — VERSION-PINNED (harness web@1.0.0 and web@2.0.0 are distinct nodes).
// Readable by design (`harness:acme:web-agent@1.0.0`) so a graph render / debug trace is legible; the parts are
// structured (type + tenant + key), so collisions across types/tenants cannot happen. `key` may itself contain any
// character (a repo "owner/name", an OIDC subject) — that is fine, it is the trailing free component.
export function nodeId(tenant: string, ref: NodeRef): string {
  const base = `${ref.type}:${tenant}:${ref.key}`;
  return ref.version === undefined ? base : `${base}@${ref.version}`;
}

// Deterministic mention id: same (source, node reference, extractor) → same id. A re-harvest is therefore idempotent;
// a re-extraction with a NEW `extractor` version appends a new row (append-only), never mutating the old one.
export function mentionId(parts: {
  sourceKind: SourceKind;
  sourceId: string;
  nodeType: NodeRef["type"];
  nodeRef: string;
  extractor: string;
}): string {
  return `mtn_${cyrb53([parts.sourceKind, parts.sourceId, parts.nodeType, parts.nodeRef, parts.extractor].join(SEP))}`;
}

// Deterministic edge id: same (source, predicate, endpoints, extractor) → same id.
export function edgeId(parts: {
  sourceKind: SourceKind;
  sourceId: string;
  predicate: Predicate;
  subject: string;
  object: string;
  extractor: string;
}): string {
  return `edg_${cyrb53([parts.sourceKind, parts.sourceId, parts.predicate, parts.subject, parts.object, parts.extractor].join(SEP))}`;
}
