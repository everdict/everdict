import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { BadRequestError } from "../errors.js";

// ── OPERATION CARDINALITY EQUALS DECISION CARDINALITY (arch-review 53, Wave C) ───────────────────────
//
// Wave 4 moved a settlement's outward effects behind a plan that rides the terminal transaction, which fixed
// the ORDER: nothing is published by an attempt that did not commit. It left the SHAPE wrong. The plan lived
// in one mutable field on the scorecard row (`publication?: PublicationPlan`) while the decisions it serves
// are plural — one initial settlement and any number of re-score settlements, each owing its own artifact
// promotion and its own export.
//
// Two failures follow directly, and both are the ordinary interleaving of a re-score against a batch whose
// first publication has not drained yet (the inline drain happens AFTER the commit, so that window is real):
//
//   · the second settle OVERWRITES the first plan, and the first settlement's export debt disappears from the
//     row with nothing recording it was owed. An operator asked "why did the traces never appear" has nothing
//     to read;
//   · the fence was `expectPublicationState: "pending"`, which asks "is SOMETHING pending", not "is the plan
//     I read still the plan". A publisher holding the OLD plan passes that CAS against the NEW one and writes
//     its own receipt over a debt it never paid — so the re-score's publication is marked published and never
//     happens.
//
// A publication is therefore an OPERATION with an identity, keyed by the settlement that owes it, and the
// ledger is append-only in the sense that matters: a new settlement adds a row, it never replaces one.
export const PUBLICATION_OPERATION_STATES = ["pending", "claimed", "published", "unverifiable"] as const;
export const PublicationOperationStateSchema = z.enum(PUBLICATION_OPERATION_STATES);
export type PublicationOperationState = z.infer<typeof PublicationOperationStateSchema>;

// WHICH settlement owes this. `scoringRevision` and `passId` together name one decision: the revision is the
// ledger entry the settle appended, the pass is the writer that appended it. A legacy settlement with no pass
// marker uses its content-addressed initial pass id, the same answer the analysis staging uses.
export const SettlementRefSchema = z.object({
  scorecardId: z.string().min(1),
  scoringRevision: z.number().int().positive(),
  passId: z.string().min(1),
});
export type SettlementRef = z.infer<typeof SettlementRefSchema>;

// One owed outward effect. The `idempotencyKey` is minted with the operation and TRAVELS TO THE SINK — Wave 4
// minted one and never passed it anywhere, so the at-least-once export had no way for the receiving platform
// to dedupe it. That is the difference between "at least once, and the sink can collapse them" and "at least
// once, and duplicates are the tenant's problem".
//
// ── THE ARTIFACT VARIANT IS GONE (arch-review 55, Wave 7) ────────────────────────────────────────────
//
// It promoted the mutable `analyses/<id>.json` alias, and that promotion was WRITE-ONLY: it happened exactly
// when the settle had also recorded the revision's own pass-scoped `analysisKey`, which is the key the
// analysis reader resolves first. Every promotion therefore wrote an object its own settlement had just made
// unreachable. It was also the one effect whose monotonicity could not be enforced — the position is read
// from this ledger and the bytes are written to an object store, with no conditional put to join them, so
// two settlements draining concurrently could still land newest-first.
//
// Wave 5 made its guard three-valued, which was correct for the defect in front of it; this removes the
// effect the guard was protecting. Rows planned before it are stripped by mig 0191, so no stored operation
// carries a variant this union no longer has.
// WHERE A SETTLEMENT'S EXPORT BYTES ARE — one shape, both ends (arch-review 55, Wave 9). Declared once and
// imported by the plan schema, the operation effect and the staging seam, because the previous version was
// spelled in two of those three and silently missing from the type of the third.
export const ExportPayloadSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frozen"), key: z.string().min(1) }),
  // ── THE SAME BYTES, A DIFFERENT HOME (arch-review 57 P1) ─────────────────────────────────────────
  //
  // An install with no object store — the ordinary self-hosted shape — could previously only plan
  // `unfrozen`, and an operation in that state is one whose bytes NOBODY holds: the drain re-reads the
  // record and compares, which converges exactly until something re-scores and then fails permanently. A
  // durable operation existing is not the same as it durably holding what it must publish.
  //
  // So the payload travels ON the operation instead, compressed. Not a weaker freeze — the same bytes,
  // verified by the same digest at drain time; only their address is different.
  z.object({
    kind: z.literal("inline"),
    encoding: z.literal("gzip+base64"),
    bytes: z.string().min(1),
    // WHY these bytes are here rather than in a store. arch-review 55 established that a failure to freeze
    // must be recorded and not look like an absence, and that is still true when the fallback works: an
    // operator reading a settle that inlined its payload should learn whether this deployment has no object
    // store at all or whether one blipped during the settle. Those call for different actions.
    reason: z.string().min(1),
  }),
  // LEGACY READ ONLY. Rows written before the inline variant existed (mig 0188's backfill, and settles from
  // installs with no store) still carry this, and the drain still knows how to take the weaker path for
  // them. Nothing PLANS it any more: a settlement that can neither freeze nor inline refuses at plan time,
  // where the operator can act, instead of at drain time where the batch is already recorded as pending.
  z.object({ kind: z.literal("unfrozen"), reason: z.string().min(1) }),
]);
export type ExportPayloadSource = z.infer<typeof ExportPayloadSourceSchema>;

// The bound on what may travel on an operation row. An outbox row is not an object store: past this, the
// honest answer is that this deployment cannot publish this settlement, said where it is actionable.
export const INLINE_EXPORT_PAYLOAD_CAP_BYTES = 512 * 1024;

// ── …AND ON WHAT THOSE BYTES BECOME (arch-review 59 P1-hardening) ────────────────────────────────────
//
// The cap above bounds the ROW. It says nothing about the allocation: highly repetitive JSON compresses by
// orders of magnitude, so a settlement that clears 512 KiB compressed can decompress to hundreds of
// megabytes — and `readExportPayload` is a synchronous gunzip plus a synchronous parse, run by the
// publication reconciler in the process every other owed publication is waiting in. The inline path is what
// a deployment without an object store takes on EVERY export, so this is the ordinary road, not an exotic
// input.
//
// Generous against any real settlement (scores and identifiers) and small enough that one of them cannot
// stall the loop. Enforced at BOTH ends: at the write, so an oversized settlement is refused at plan time
// where an operator can act; at the read, because a row written by an older version, a restored backup or
// anything else this process did not author still gets expanded here.
export const INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Read the bytes back. Same shape in, same shape out — the digest guard at drain time is what makes this
// safe, and it is applied to an inline payload exactly as it is to a frozen one.
export function readExportPayload(source: Extract<ExportPayloadSource, { kind: "inline" }>): unknown {
  // `maxOutputLength` makes zlib REFUSE rather than allocate — the bound has to be enforced by the
  // decompressor, because measuring the size afterwards means having already paid for it. Its own error is a
  // raw runtime one, so it is remapped here: monitoring should read this as our refusal, not as a Buffer
  // limit somebody has to trace back (rule `typescript`, never propagate a raw error across a boundary).
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(source.bytes, "base64"), {
      maxOutputLength: INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES,
    });
  } catch (err) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { cap: INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES },
      `this operation's inline export payload does not decompress within the ${INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES}-byte uncompressed bound, so it is not read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return JSON.parse(raw.toString("utf8"));
}

// …and write them. Throws when the result would exceed the cap, which is the plan-time refusal: an operation
// that cannot hold its own bytes must not be planned.
export function inlineExportPayload(
  payload: unknown,
  reason: string,
): Extract<ExportPayloadSource, { kind: "inline" }> {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  // The OUTPUT bound first: a payload that compresses spectacularly would otherwise clear the row cap and
  // become the reconciler's problem at drain time, where nobody can act on it.
  if (raw.length > INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES)
    throw new BadRequestError(
      "BAD_REQUEST",
      { uncompressed: raw.length, cap: INLINE_EXPORT_PAYLOAD_MAX_OUTPUT_BYTES },
      `this settlement's export payload is ${raw.length} bytes uncompressed (${reason}), past what an operation row may expand to, so the export cannot be published from this deployment without an object store.`,
    );
  const bytes = gzipSync(raw).toString("base64");
  if (bytes.length > INLINE_EXPORT_PAYLOAD_CAP_BYTES)
    throw new BadRequestError(
      "BAD_REQUEST",
      { bytes: bytes.length, cap: INLINE_EXPORT_PAYLOAD_CAP_BYTES },
      `this settlement's export payload is too large to travel on the operation (${reason}), so the export cannot be published from this deployment — wire an object store (S3/MinIO) for batches this size.`,
    );
  return { kind: "inline", encoding: "gzip+base64", bytes, reason };
}

export const PublicationEffectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("export"),
    idempotencyKey: z.string().min(1),
    // What the settlement counted. A drain whose results do not digest to this is looking at a plane the
    // settlement never published — it publishes nothing and says so.
    payloadDigest: z.string().min(1),
    // …AND WHERE THOSE BYTES ARE (arch-review 54, Phase 4 · made a union arch-review 55, Wave 9). The digest
    // alone made the operation refusable but not performable: the drain re-read the record's CURRENT results,
    // so an ordinary re-score between the settle and the drain moved the plane, the digests disagreed, and the
    // older settlement's owed export closed PERMANENTLY unverifiable. The operation survived; the bytes it
    // owed did not. Refusing to ship the new bytes under the old receipt was right; concluding the old export
    // could therefore never happen was a consequence of nobody having frozen what it owed.
    //
    // It shipped as an OPTIONAL key, whose absence was documented as the legacy shape (mig 0188's backfill).
    // It was not only that. `stageAnalysis` froze the payload best-effort, so a live settlement whose object
    // store blipped for one PUT produced a row byte-identical to one migrated from before the feature existed
    // — and the absent field was doing two incompatible jobs: "this predates payload freezing" (our history)
    // and "this settlement tried and failed" (an incident on THIS batch). Nothing could tell them apart and
    // nothing said why.
    //
    // So the weaker case is NAMED and carries its reason. `frozen` is performable: read the immutable object,
    // check its digest, export exactly what the settlement counted, converge whatever else has happened since.
    // `unfrozen` keeps the pre-Phase-4 behaviour exactly — compare the live plane, refuse on mismatch, which
    // is fail-closed and cannot converge after a re-score — and says out loud that this is the weaker path and
    // why it is being taken.
    payload: ExportPayloadSourceSchema,
    sink: z.string().optional(),
    judgeModels: z.record(z.string(), z.string()).optional(),
    attach: z.object({ sourceKind: z.string(), externalIdByCase: z.record(z.string(), z.string()) }).optional(),
  }),
]);
export type PublicationEffect = z.infer<typeof PublicationEffectSchema>;

export const PublicationOperationSchema = z.object({
  // The operation's own identity — what a publisher claims and completes. Derived from the settlement so two
  // processes settling the same pass cannot mint two operations for one decision.
  id: z.string().min(1),
  settlement: SettlementRefSchema,
  // `pending` — owed, unclaimed. `claimed` — a publisher holds a lease on it. `published` — the effects ran
  // and the receipt is written. `unverifiable` — the drain established that this operation can never be
  // performed (its staged bytes are gone, its plane moved), so it closes with the reason rather than sitting
  // owed forever. Only `pending` is swept.
  state: PublicationOperationStateSchema,
  effects: z.array(PublicationEffectSchema),
  plannedAt: z.string(),
  publishedAt: z.string().optional(),
  // Diagnostics for an operator, never control: `state` alone decides whether the sweep retries.
  lastError: z.string().optional(),
  // Who holds the claim and until when. A lease that has expired is reclaimable by the sweep — the same
  // stale-owner rule the scoring pass uses, for the same reason (a publisher's process can die mid-drain).
  claimedBy: z.string().optional(),
  leaseUntil: z.string().optional(),
});
export type PublicationOperation = z.infer<typeof PublicationOperationSchema>;

// One decision, one operation id. Stable and content-free: two replicas settling the same pass compute the
// same id, so the store's unique key does the deduplication rather than a race.
export function publicationOperationId(settlement: SettlementRef): string {
  return `${settlement.scorecardId}#r${settlement.scoringRevision}#${settlement.passId}`;
}
