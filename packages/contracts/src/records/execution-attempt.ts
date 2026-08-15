import { z } from "zod";

// ── EVERY PHYSICAL EXECUTION LEAVES A ROW (arch-review 42, Three-Ledger Phase 1) ─────────────────────
//
// The receipt (case-commit-receipt.ts) says which attempt EARNED the case, and the recording says which
// attempt produced the frames. Neither says which attempts HAPPENED. That gap is not cosmetic: the spillover
// duplicate, the OOM boost, the speculation loser, the re-lease and the retryable-throw re-dispatch all spend
// real compute, and the only trace any of them left was a recording row — which exists only when a producer
// happened to record something, and is evidence-lifetime rather than audit-lifetime.
//
// So the physical execution gets its own ledger, and the row is UNCONDITIONAL: it is written when the
// execution begins, before anyone knows whether it will produce evidence, win the case, or be abandoned
// mid-flight. "Nothing was recorded" and "nothing ran" stop being the same observation.
//
// THE STATES, and what each one asserts:
//   created     — the attempt was minted; a physical execution is about to begin under this coordinate.
//   executing   — compute actually started (a backend dispatched it, a runner leased it).
//   committed   — this attempt's result is the case's answer (its receipt claim won).
//   superseded  — another attempt owns the case, or this one was abandoned before it could claim it.
//   failed      — this attempt ended in a failure that was final for it.
//
// The vocabulary is CLOSED HERE and nowhere else — deliberately no SQL CHECK constraint, for the same reason
// the receipt's `kind` has none (mig 0181): the boundary that refuses an unknown state is this schema, and
// adding a state must not require a migration to be refusable.
export const ExecutionAttemptStateSchema = z.enum(["created", "executing", "committed", "superseded", "failed"]);
export type ExecutionAttemptState = z.infer<typeof ExecutionAttemptStateSchema>;

// The states after which an attempt's story is over. Written ONCE because both store implementations arbitrate
// on it — two hand-enumerated terminal sets is how a guard drifts into a set that admits the write it exists
// to refuse.
export const TERMINAL_ATTEMPT_STATES: readonly ExecutionAttemptState[] = ["committed", "superseded", "failed"];

export function isTerminalAttemptState(state: ExecutionAttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.includes(state);
}

// ONE PHYSICAL EXECUTION, as the ledger holds it.
export const ExecutionAttemptRecordSchema = z.object({
  // `<executionId>#g<generation>` — the SAME spelling the receipt and the sealed trajectory use (attemptIdOf).
  // A second spelling here would recreate the very split those two were joined to close.
  attemptId: z.string(),
  // The logical execution this is an attempt OF: stable across every retry of one case (`evd-<batch>-<case>`,
  // `evd-run-<id>`), which is why it alone cannot name a physical execution.
  executionId: z.string(),
  // The attempt ordinal within that execution. Starts at 1: generation 0 is what a producer that was never
  // told a number stamps, and it must stay distinguishable from a real attempt.
  generation: z.number().int().min(1),
  tenant: z.string(),
  // The batch coordinate, when the attempt belongs to one. A standalone run has none.
  scorecardId: z.string().optional(),
  caseId: z.string().optional(),
  trial: z.number().int().nonnegative().optional(),
  // The child run this attempt wrote to, once it exists — an attempt is opened at dispatch intent, and the
  // child row may be created after (or never, for a batch with no run store).
  childRunId: z.string().optional(),
  // The authority the attempt was opened under: the batch driver's fencing epoch, and — for a self-hosted
  // re-lease — the lease generation the hub minted. Recorded so "which authority spent this compute" is a
  // question the ledger answers rather than one an operator reconstructs from logs.
  driverEpoch: z.number().int().nonnegative().optional(),
  leaseEpoch: z.number().int().nonnegative().optional(),
  state: ExecutionAttemptStateSchema,
  // The attempt ran WITHOUT a raised fence — the recording coordinate it should have claimed was refused, so
  // its producers write under no generation at all. The execution is still real, which is exactly why the row
  // exists; what it is not is canonical evidence.
  unisolated: z.boolean().default(false),
  // What ended it, for the terminal states that have a reason (failed, and a superseded attempt abandoned by
  // a retry carries the failure that triggered the retry).
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  openedAt: z.string(),
  updatedAt: z.string(),
});
export type ExecutionAttemptRecord = z.infer<typeof ExecutionAttemptRecordSchema>;
