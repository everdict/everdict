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

// ── THE EXECUTION'S OWN DIGEST — INVARIANT UNDER RE-JUDGMENT (arch-review 41 P1) ─────────────────────
//
// `caseResultDigest` covers the WHOLE result, scores included — correct for "are these the exact bytes the
// commit persisted", and wrong for "is this still the execution the receipt vouches for": a re-score
// legally replaces `scores` in place (writeBackScores, under the pass fence), so the full digest of a
// re-scored child diverges from its receipt forever, and an auditor cannot tell a legitimate re-judgment
// from tampering. This digest names the OBSERVATION only — what the agent/runtime did — by dropping the
// mutable judgment plane (scores) and the judgment's evidence spans (`judge:*`, appended by the scoring
// merge). The receipt carries both: `resultDigest` freezes commit-time bytes, `observationDigest` stays
// true across every judgment revision. Same parse-first spelling as above, same reason.
export function caseObservationDigest(result: CaseResult): string {
  const parsed = CaseResultSchema.parse(result);
  // `judgmentsSealed` is dropped for the same reason `scores` is: it is the SCORER's vouch, written by the
  // judging pass, and a re-score legally rewrites it. Leaving it in made every re-judged case's observation
  // digest diverge from its receipt forever — the exact failure this digest exists to prevent, and the test
  // beside it caught the field on its way in (arch-review 58 follow-through).
  const { judgmentsSealed: _judgment, ...observation } = parsed;
  return contentDigest({
    ...observation,
    scores: [],
    trace: parsed.trace.filter((e) => !(e.kind === "span" && e.name.startsWith("judge:"))),
  });
}
