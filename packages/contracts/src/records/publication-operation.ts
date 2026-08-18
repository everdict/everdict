import { z } from "zod";

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
export const PublicationEffectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("export"),
    idempotencyKey: z.string().min(1),
    // What the settlement counted. A drain whose results do not digest to this is looking at a plane the
    // settlement never published — it publishes nothing and says so.
    payloadDigest: z.string().min(1),
    // …AND WHERE THOSE BYTES ARE (arch-review 54, Phase 4). The digest alone made the operation refusable but
    // not performable: the drain re-read the record's CURRENT results, so an ordinary re-score between the
    // settle and the drain moved the plane, the digests disagreed, and the older settlement's owed export was
    // closed PERMANENTLY unverifiable. The operation survived; the bytes it owed did not.
    //
    // Refusing to ship the new bytes under the old receipt was right. Concluding the old export can therefore
    // never happen was not — nobody had frozen what it owed. Staged as an immutable object at settle time, so
    // the drain reads what the settlement counted instead of whatever the record says now. The artifact effect
    // above has worked this way since Wave C; only the export half reached for live state.
    //
    // Optional for the operations mig 0188 backfilled from the pre-Phase-4 field: they carry a digest and no
    // key, and the drain treats them exactly as before (re-read, compare, refuse on mismatch).
    payloadKey: z.string().min(1).optional(),
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
