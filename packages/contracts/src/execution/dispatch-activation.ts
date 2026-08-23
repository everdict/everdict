import { type ExecutionAttemptState, isTerminalAttemptState } from "../records/execution-attempt.js";

// ── MAY THIS DISPATCH CREATE EXTERNAL WORK, RIGHT NOW? (arch-review 57 P0) ───────────────────────────
//
// A reservation is a capability, and until this existed it had no lifetime. The caller that won one held it
// across whatever happened next — a GC pause, a slow cluster API, a rescheduled pod — and nothing re-consumed
// it before the external object was created:
//
//   driver A   reserve W → ok, then pauses
//   cancel     parent CANCELLED · kill W → absent · probe W → absent · children terminal · COMPLETED
//   driver A   wakes and creates W
//
// The exact-absence probe added in arch-review 56 proves absence at the moment it read. It cannot prove that
// nothing is born afterwards, and the same-id re-check does not apply either: A is not requesting a new
// reservation, it is spending the one it holds. A cancellation that verified zero live work is then followed
// by live work — the thing rule `protocol` L5 exists to forbid.
//
// So the proof is re-presented at the seam where the effect actually begins. This is that decision, kept pure
// and total so both managed lanes ask the same question and a counterexample can drive it without a cluster.
// The STORE performs it as a conditional transition (`reserved → active` on the exact work id); this function
// is what that transition means, and what a lane does when the answer is no.
export type ActivationDecision =
  | { kind: "activate" }
  // The external object for this exact work already exists and this attempt made it. At-least-once delivery
  // is ordinary, so a re-driven dispatch must converge on the SAME object rather than create a second one.
  | { kind: "already_active" }
  | { kind: "refuse"; reason: string };

export interface ActivationRequest {
  // The attempt's state as the ledger holds it NOW — not as the caller remembers it from before its pause.
  state: ExecutionAttemptState;
  // The work id this attempt reserved, if any.
  recordedWork: string | undefined;
  // The work id this dispatch is about to create.
  work: string;
  // Whether the run/batch this attempt belongs to may still author external work. A cancellation revokes
  // that, and a row the sweep has not reached yet is not permission (rule `protocol` L1: a proof has a
  // lifetime, and the effect re-proves it).
  parentOpen: boolean;
}

export function decideActivation(request: ActivationRequest): ActivationDecision {
  const { state, recordedWork, work, parentOpen } = request;
  // Asked first, because it is the answer that does not depend on which attempt row this is: after a
  // cancellation nothing may be born, whatever state the attempt was left in.
  if (!parentOpen)
    return { kind: "refuse", reason: "the run this attempt belongs to may no longer author external work" };
  if (state === "revoked")
    return { kind: "refuse", reason: "this reservation was revoked — a cancellation already took it back" };
  // ── ASKED THROUGH THE PREDICATE, NOT A COPY OF ITS CONTENTS (arch-review 64) ─────────────────────
  //
  // This read `state === "committed" || state === "failed" || state === "superseded"` — the terminal set,
  // hand-copied. When `verdict_produced` was added the copy did not grow, so an attempt that had already
  // produced its verdict and had its container reclaimed fell through every arm here and was AUTHORIZED to
  // create new work. Exactly the failure `MAY_STILL_CREATE_WORK` was exported to make impossible, in the one
  // function that decides a birth.
  //
  // `verdict_produced` is named separately from the terminals because it is not one: the row is waiting to
  // learn whether the case adopts its bytes. What it may not do is make more.
  if (isTerminalAttemptState(state))
    return { kind: "refuse", reason: `this attempt is settled (${state}) and cannot create new work` };
  if (state === "verdict_produced")
    return { kind: "refuse", reason: "this attempt already produced its verdict and may not create new work" };
  if (recordedWork === undefined)
    return { kind: "refuse", reason: "this attempt reserved no work, so there is nothing it is authorized to create" };
  // A reservation authorizes ONE external object. Spending it on another id is how a lane creates compute the
  // ledger does not address — which is the defect the work handle was introduced to end.
  if (recordedWork !== work)
    return {
      kind: "refuse",
      reason: `this attempt reserved '${recordedWork}', not '${work}' — a reservation authorizes one object`,
    };
  if (state === "active" || state === "executing") return { kind: "already_active" };
  return { kind: "activate" };
}
