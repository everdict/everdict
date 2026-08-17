import { createHash } from "node:crypto";

// ── A RETRIED EXPORT MUST BE THE SAME EXPORT (arch-review 54, Phase 4) ───────────────────────────────
//
// The export is at-least-once against a crash between the sink call and the receipt: the publication
// operation stays owed and the reconciler calls the sink again. Every adapter here minted its trace, run and
// event ids with `crypto.randomUUID()`, so the second call created a SECOND trace on the tenant's platform —
// same batch, same judgments, two records, and nothing in either saying they are the same export.
//
// `PublicationEffect.idempotencyKey` is minted with the operation and is stable across every retry of it. A
// generator seeded from that key yields the same sequence for the same export, so the ids an adapter produces
// are a function of WHICH EXPORT this is rather than of when it ran. Platforms that upsert by id (Langfuse's
// ingestion, MLflow's run tags, Phoenix's spans) then collapse the duplicate on their side, which is the only
// place it can be collapsed.
//
// Deterministic from the ORDER of calls, which is what makes it work without threading a label through every
// call site: the adapters build their payloads by walking cases and trace events in a fixed order, so call
// number N is the same object on every attempt. That is also its limit, and it is why the seeded generator is
// used ONLY when a key is present — a live per-case stream has no retry to collapse, mints ids as it goes,
// and would otherwise silently reuse one sequence across unrelated exports.
export function seededIds(seed: string): () => string {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(`${seed}#${counter++}`).digest("hex");
    // UUID-shaped: the platforms accept an opaque string, and several of them display it in fields whose
    // formatting assumes a UUID. Version/variant nibbles are set so it is a well-formed v4-looking id.
    const hex = `${digest.slice(0, 12)}4${digest.slice(13, 16)}${((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 32)}`;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
}
