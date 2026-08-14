import { z } from "zod";

// ── THE CANONICAL OUTCOME OF ONE CASE (review 39 P0) ─────────────────────────────────────────────────
//
// Several PHYSICAL executions of one logical case are normal, not exceptional: a runtime spillover, an OOM
// re-run at a higher ceiling, a speculative duplicate, a recovery re-drive. Each writes a child row, and
// which of them the parent counted was decided by `latestChildPerCase` — the row with the largest
// `updatedAt`. That is not "which attempt earned the right to commit"; it is "which row was touched last",
// and a late metadata update on a superseded attempt is enough to change the answer after the fact.
//
// The receipt is the commit point. Exactly one may exist per (scorecard, case, trial) — a database UNIQUE
// constraint, so the winner is decided by the same mechanism that decides every other terminal write here,
// rather than by a comparison made afterwards over rows that are all equally real. Attempts that lose leave
// their evidence in place; what they do not get is the receipt, and the parent's summary is built from
// receipts.
//
// It records DIGESTS rather than the payloads: the payload lives on the child row and in object storage, and
// a digest is what lets a reader ask "is the thing I fetched the thing this decision was made on" — which is
// the question every artifact key in this system has had to answer the hard way.
export const CaseCommitReceiptSchema = z.object({
  scorecardId: z.string(),
  caseId: z.string(),
  trial: z.number().int().nonnegative(), // 0 for a single-run case — the same collapse `childKey` makes
  // The child run this receipt makes canonical. Other attempts of the same case keep their rows; only this
  // one is the case's outcome.
  childRunId: z.string(),
  // The id the winning attempt actually executed under (`evd-<batchId>-<caseId>[-t<n>]`) plus the recording
  // attempt it owned. Together they name the physical execution whose evidence this receipt vouches for —
  // which is the question a replay reader has to answer and could not.
  executionId: z.string().optional(),
  generation: z.number().int().nonnegative().optional(),
  // The two joined into the one name every other consumer uses (see attemptIdOf). Absent when the committer
  // could not know it — a recovery adopting a result from a backend never opened the attempt that made it.
  attemptId: z.string().optional(),
  // The committed result's content digest — the parent's scoring digest is computed over these, so a
  // recomputation from the ledger can be compared against what the parent actually decided.
  resultDigest: z.string(),
  // The EXECUTION's own digest — scores and judge:* evidence spans excluded (arch-review 41 P1). A re-score
  // legally replaces the child's scores in place, so `resultDigest` (commit-time bytes) diverges from a
  // re-scored row forever; this one is invariant under re-judgment and is what "is this still the execution
  // the receipt vouches for" compares. Absent on receipts committed before the split.
  observationDigest: z.string().optional(),
  // What the case's judges were asked, sealed at the commit: a receipt whose judge closure differs from the
  // batch's selection is a case judged under a different question.
  judgeClosureDigest: z.string().optional(),
  committedAt: z.string(),
});
export type CaseCommitReceipt = z.infer<typeof CaseCommitReceiptSchema>;

// ── ONE NAME FOR ONE PHYSICAL EXECUTION (review 39) ──────────────────────────────────────────────────
//
// The identity of an attempt was split across two axes that nobody could join: `executionId` (stable across
// every retry of a logical case — a correlation id) and the recording `generation` (the fence a producer
// stamps). Neither alone answers "which execution produced this", and every consumer that needed to ask —
// the receipt, the sealed trajectory, the object-store key — invented its own spelling of the pair.
//
// This is the spelling. Total, pure, and boring on purpose: `<executionId>#g<generation>`. What matters is
// that the receipt, the replay and the artifact all say the SAME string, so a reader can compare them
// instead of trusting that they were derived the same way.
export function attemptIdOf(executionId: string, generation: number): string {
  return `${executionId}#g${generation}`;
}

// What a commit attempt learns. `already_committed` carries the receipt that won, because the caller's next
// question is always "then whose is it" — and answering it from a second read would be racing again.
export type CaseCommitOutcome =
  | { kind: "committed"; receipt: CaseCommitReceipt }
  | { kind: "already_committed"; receipt: CaseCommitReceipt };
