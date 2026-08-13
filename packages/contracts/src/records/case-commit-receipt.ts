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
  // The committed result's content digest — the parent's scoring digest is computed over these, so a
  // recomputation from the ledger can be compared against what the parent actually decided.
  resultDigest: z.string(),
  // What the case's judges were asked, sealed at the commit: a receipt whose judge closure differs from the
  // batch's selection is a case judged under a different question.
  judgeClosureDigest: z.string().optional(),
  committedAt: z.string(),
});
export type CaseCommitReceipt = z.infer<typeof CaseCommitReceiptSchema>;

// What a commit attempt learns. `already_committed` carries the receipt that won, because the caller's next
// question is always "then whose is it" — and answering it from a second read would be racing again.
export type CaseCommitOutcome =
  | { kind: "committed"; receipt: CaseCommitReceipt }
  | { kind: "already_committed"; receipt: CaseCommitReceipt };
