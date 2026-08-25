import type { CaseResult } from "@everdict/contracts";
import { caseObservationDigest, caseResultDigest } from "@everdict/domain";
import type { CaseReceiptStore } from "../ports/case-receipt-store.js";
import type { RunStore } from "../ports/run-store.js";

// ── "A RECEIPT EXISTS" IS NOT "MY RESULT IS THE ONE THAT COMMITTED" (arch-review 67 P0-canonicality) ─
//
// When a commit's RESPONSE is lost, the question is not "did anything commit for this child" — it is "what
// is the canonical answer for it now". Those come apart exactly when it matters: a concurrent writer can
// have committed a different result for the same child, and a recovery that reads only for EXISTENCE then
// seeds its own process-local document into the rebuilt batch. The ledger holds one result and the
// aggregate reports another, silently, with the receipt's own digest as the contradiction.
//
// That is a worse failure than the duplicate dispatch this arm was added to prevent. A double-spend is
// visible in the ledger and in the bill; this is not visible anywhere.
//
// So the read-back returns the PERSISTED result, corroborated against what the receipt sealed. A caller's
// local copy is for comparison, never for seeding.
export type CommitReadback =
  // The commit landed, and this is the document the ledger holds for it.
  | { kind: "landed"; result: CaseResult; reason: string }
  // Nothing was persisted — the re-drive is safe, and is now a decision made from a read.
  | { kind: "not_landed"; reason: string }
  // A receipt exists and the child cannot corroborate it: the row is missing, carries no result, or carries
  // one whose digest is not what the receipt vouched for. Something is wrong that a resume must not paper
  // over by picking a side.
  | { kind: "inconsistent"; reason: string }
  // A read that would not answer. Same fail-closed direction as everywhere else (rule `protocol` L2), and
  // RETURNED rather than thrown: an exception here becomes whatever the nearest generic handler means.
  | { kind: "unknown"; reason: string };

// One owner, because every caller that has to ask "did my commit land" must answer it the same way.
export async function commitReadback(
  receipts: Pick<CaseReceiptStore, "read">,
  runs: Pick<RunStore, "get">,
  scorecardId: string,
  childRunId: string,
): Promise<CommitReadback> {
  const receiptsRead = await receipts.read(scorecardId);
  if (receiptsRead.kind === "unknown")
    return { kind: "unknown", reason: `the receipt ledger would not answer: ${receiptsRead.reason}` };
  const receipt =
    receiptsRead.kind === "read" ? receiptsRead.value.find((r) => r.childRunId === childRunId) : undefined;
  if (!receipt) return { kind: "not_landed", reason: "no receipt names this child" };

  // The child row is the other half of the pair. A receipt is a CLAIM about a result; the row is where the
  // result lives, and a claim nothing corroborates is not something to resume on.
  const child = await runs
    .get(childRunId)
    .then((row) => ({ kind: "read" as const, row }))
    .catch((err: unknown) => ({ kind: "unknown" as const, reason: err instanceof Error ? err.message : String(err) }));
  if (child.kind === "unknown") return { kind: "unknown", reason: `the child row would not answer: ${child.reason}` };
  if (!child.row)
    return { kind: "inconsistent", reason: `a receipt claims child ${childRunId} committed, and no such row exists` };
  const result = child.row.result;
  if (!result)
    return {
      kind: "inconsistent",
      reason: `a receipt claims child ${childRunId} committed, and its row carries no result`,
    };

  // Compared on the OBSERVATION digest when the receipt has one: a legitimate re-score rewrites the child's
  // scores in place, so `resultDigest` (commit-time bytes) diverges from a re-judged row forever while the
  // observation digest is invariant under re-judgment — which is exactly the "is this still the execution
  // the receipt vouches for" question the schema documents. Older receipts carry only the commit-time one,
  // and comparing THAT against a re-scored row would report a healthy batch as inconsistent.
  const vouched = receipt.observationDigest ?? receipt.resultDigest;
  const actual = receipt.observationDigest !== undefined ? caseObservationDigest(result) : caseResultDigest(result);
  if (actual !== vouched)
    return {
      kind: "inconsistent",
      reason: `child ${childRunId} holds a result digesting to ${actual}, and its receipt vouched for ${vouched}`,
    };
  return { kind: "landed", result, reason: `child ${childRunId} committed and its row corroborates the receipt` };
}
