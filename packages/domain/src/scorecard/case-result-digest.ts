import { type CaseResult, CaseResultSchema } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

// ── THE ONE SPELLING OF A CASE RESULT'S DIGEST (review 40 P0 follow-up) ──────────────────────────────
//
// A receipt's `resultDigest` is compared against bytes that live on BOTH sides of a schema round-trip: the
// in-process object the driver holds (a producer literal — its scores may carry no `status`), and the child
// row read back off jsonb (which `ScoreSchema`'s read-time normalizer has stamped `status: "measured"`,
// legacy sentinels rewritten). Those are the SAME measurement in two shapes, and `contentDigest` is a shape
// hash — so a digest stamped over one form and checked against the other reported divergence on every case
// that crossed Postgres, and the fail-closed ledger gate then refused every batch. The content-digest module
// warned about exactly this ("a subject that later embeds scores must digest the parsed form").
//
// So every stamp and every comparison goes through the parse first: one canonical form, one function, and a
// digest that answers "is this the same measurement?" instead of "did this object cross a schema yet?".
export function caseResultDigest(result: CaseResult): string {
  return contentDigest(CaseResultSchema.parse(result));
}
