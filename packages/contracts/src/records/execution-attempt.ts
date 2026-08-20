import { z } from "zod";
import { RuntimeWorkRefSchema } from "../execution/runtime-work-ref.js";

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
//   reserved    — this attempt has AUTHORIZED external work and holds its handle, but the orchestrator has
//                  not been asked yet (arch-review 55, Wave 1). It exists so that "may this caller still
//                  place work?" is a question the LEDGER answers rather than one a caller remembers: the
//                  reservation is the `created → reserved` transition, conditional on the attempt being
//                  fresh, unreserved, and belonging to a parent this driver still owns. Without it the
//                  reservation was a metadata update that a superseded attempt, a displaced driver and a
//                  cancelled batch all passed.
export const ExecutionAttemptStateSchema = z.enum([
  "created",
  "reserved",
  // ── THE WINDOW BETWEEN A RESERVATION AND A BIRTH (arch-review 57 P0) ────────────────────────────
  //
  // `reserved` used to run straight into `executing`, with the external object created somewhere in
  // between and nothing able to name that moment. So a driver holding a reservation could pause, have its
  // parent cancelled and verified free of live work, wake, and THEN create the job — a cancellation that
  // certified zero followed by a birth.
  //
  // `active` is "the external object exists and this attempt is the one that made it"; `revoked` is the
  // state a cancellation puts a reservation into so the holder has something to fail against. A dispatch
  // re-presents its reservation at activation time (`decideActivation`) rather than spending a proof whose
  // lifetime nobody bounded.
  "active",
  "revoked",
  "executing",
  "committed",
  "superseded",
  "failed",
]);
export type ExecutionAttemptState = z.infer<typeof ExecutionAttemptStateSchema>;

// The states after which an attempt's story is over. Written ONCE because both store implementations arbitrate
// on it — two hand-enumerated terminal sets is how a guard drifts into a set that admits the write it exists
// to refuse.
// `revoked` is TERMINAL: a reservation a cancellation took back is not one a later dispatch may spend, and a
// revoked attempt is not revived — a re-drive opens a new attempt, which is what the generation is for
// (arch-review 57 P0). `active` is NOT terminal; it is an attempt with a live external object.
export const TERMINAL_ATTEMPT_STATES: readonly ExecutionAttemptState[] = [
  "committed",
  "superseded",
  "failed",
  "revoked",
];

export function isTerminalAttemptState(state: ExecutionAttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.includes(state);
}

// The states an attempt may report `executing` FROM — written once, for the same reason as the set above.
// `active` joined this list late (arch-review 58): the state was added between `reserved` and the external
// object's birth without being added to the transition table beside it, and nothing supplied `onActivate`,
// so no attempt ever occupied it and the omission cost nothing. The moment a producer existed, every managed
// dispatch walked `reserved → active → (executing REFUSED) → committed` — the run still finished, and the
// ledger recorded work that was authorized and then settled with no phase saying it ran.
// A new state is not shipped until every guard that mentions its NEIGHBOURS has been re-read.
export const EXECUTING_PREDECESSOR_STATES: readonly ExecutionAttemptState[] = ["created", "reserved", "active"];

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
  // WHERE this attempt's compute actually is (arch-review 52, Wave 2) — the orchestrator object the placement
  // backend created for it, stamped when the backend reports it (`DispatchOptions.onWork`). The ledger is the
  // only place a handle can survive the process that dispatched it, which is the whole point: a teardown after
  // a control-plane restart has nothing else to address the work by, and addressing it by case id reaches
  // other runs' compute. Absent = this lane minted no handle (a self-hosted lease, a legacy row, an attempt
  // whose stamp lost the race with the crash) — and absence is what makes the case-id fallback conditional
  // rather than the default.
  runtimeWork: RuntimeWorkRefSchema.optional(),
  openedAt: z.string(),
  updatedAt: z.string(),
});
export type ExecutionAttemptRecord = z.infer<typeof ExecutionAttemptRecordSchema>;
