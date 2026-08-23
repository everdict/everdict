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
  // ── A SUB-STEP PRODUCED BYTES; THE CASE HAS NOT ADOPTED THEM (arch-review 64 P1-high) ────────────
  //
  // `committed` means "this attempt's result is the case's answer". The verifier lane stamped it the moment
  // its container returned scores — and after that moment the merge can still refuse the verdict (it was
  // produced against a different workspace), the deferred collection can still fail, a speculative sibling
  // can still win the receipt, and the settlement can still not happen at all. So the row claimed an
  // adoption that three later steps could withhold.
  //
  // The compensation that was supposed to cover it could never run: `committed` is terminal and every store
  // is first-terminal-wins, so `committed → superseded` is refused by construction. A compensation the state
  // machine forbids is not a compensation (rule `protocol`, the sub-step-terminal law).
  //
  // This phase is NOT terminal, deliberately: it is a row whose external object is gone and whose bytes are
  // staged, still waiting to learn whether the case took them. From here `committed` is written by the
  // canonical settlement and by nothing else, and `superseded` is reachable — which is what makes the
  // refused-merge correction a real write rather than a request.
  "verdict_produced",
  "committed",
  "superseded",
  "failed",
]);
export type ExecutionAttemptState = z.infer<typeof ExecutionAttemptStateSchema>;

// ── WHY THERE IS NO `verdict_produced` (arch-review 63, considered and declined) ──────────────────────
//
// The review asked for a state between "this attempt's verdict is in hand" and "this attempt's result is the
// case's answer", so that `committed` could be written only by the settlement. The distinction is real; the
// state is not what closes it, and the empirical case is already closed by the vocabulary above:
//
//   - `committed` is CONDITIONAL on the parent still authorizing (see the store's transition guard). A
//     verifier that produced its verdict while a cancellation settled the batch is refused, and the caller
//     turns the refusal into `tests_pass: unmeasured` — not a `1`.
//   - a verdict the merge REFUSED settles `superseded`, so no attempt is left claiming it contributed.
//   - on the standalone path `committed` is stamped inside the settlement's own transaction, so it cannot be
//     written by anything else.
//
// What would remain is a naming refinement with no defect behind it — and its cost is the failure this very
// wave was written by. Every guard that mentions a state's NEIGHBOURS has to be re-read when the machine
// grows (see `EXECUTING_PREDECESSOR_STATES` below, added late and inert until a producer existed, and
// `MAY_STILL_CREATE_WORK`, which a teardown had spelled inline as a subset that stopped being one). Growing
// the vocabulary to express a distinction no reader currently gets wrong is how those two happened.
//
// The condition for revisiting is a READER: a decision that must tell "produced a verdict" from "produced
// the case's answer" and currently cannot. Add the state then, with that reader's counterexample.

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

// The states a VERDICT may be reported from. A verdict is reported by a lane whose object exists, so the row
// is `executing` on a lane that stamps it and `active` on one that has not got there — never `created`, which
// would be a verdict from an attempt that reserved nothing.
//
// Its own list rather than a reuse of the one above: they overlap today and they answer different questions,
// and a set shared for its current contents is the shape that stopped being a superset without anyone
// noticing (see `MAY_STILL_CREATE_WORK`, which is derived precisely because it must NOT drift).
export const VERDICT_PREDECESSOR_STATES: readonly ExecutionAttemptState[] = ["reserved", "active", "executing"];

// What may become `committed` — the CANONICAL adoption. Written by the settlement transaction only: a lane
// that produced evidence stops at `verdict_produced` and the settlement decides whether the case took it.
export const COMMIT_PREDECESSOR_STATES: readonly ExecutionAttemptState[] = [
  "created",
  "reserved",
  "active",
  "executing",
  "verdict_produced",
];

// ── THE STATES FROM WHICH AN EXTERNAL OBJECT MAY STILL BE BORN (arch-review 60 P0) ───────────────────
//
// A cancellation certifies zero by killing every handle the ledger holds and reading each one back absent.
// That is "nothing is running"; it is not "nothing can start", and the difference is exactly the attempts
// whose submitter has not created its object yet. The teardown spelled that set inline as
// `state === "reserved"` and `state === "active"` — a subset of a state machine that had grown, so an
// attempt already stamped `executing` fell through both guards, and a submitter paused between the stamp and
// `applyJob` created its Job after the certificate said zero.
//
// It is deliberately the SAME list as the one above, and not by coincidence: `executing` is the report that
// the object exists, so every state that can still reach it is a state that can still cause a birth. Derived
// rather than copied, because two lists that must agree are two lists that will not.
//
// A guard consumes THIS. Adding a state to the machine then breaks the guard's exhaustiveness rather than
// silently narrowing it, which is the failure this constant exists to make impossible.
export const MAY_STILL_CREATE_WORK: readonly ExecutionAttemptState[] = EXECUTING_PREDECESSOR_STATES;

export function mayStillCreateWork(state: ExecutionAttemptState): boolean {
  return MAY_STILL_CREATE_WORK.includes(state);
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
