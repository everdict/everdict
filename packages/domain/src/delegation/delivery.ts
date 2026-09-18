import { ConflictError, type DelegateDeliveryMode, type DelegateState } from "@everdict/contracts";

// ── WHAT REACHING A DELEGATE DOES TO THE TURN IT IS IN ───────────────────────────────────────────────
//
// The decision that used to be a single `if (active) throw 409`. That line answered one question ("is it
// busy?") for three different intentions, and it answered all of them the most disruptive way available:
// refuse, and let the supervisor decide between waiting and killing the session.
//
// Splitting it is not about adding options. It is that "the delegate is busy" is a fact about TIMING, and
// timing is only a refusal for one of the three modes — the one that has nothing to say if it waits.

export type DeliveryPlan =
  // Put it in the mailbox. Nothing starts, nothing stops; the delegate reads it when it next looks.
  | { kind: "queue"; startsTurn: false }
  // Start a turn now. The delegate is idle, so there is no boundary to wait for.
  | { kind: "start" }
  // The delegate is mid-turn: queue it and let the turn deliver it at its next boundary. This is the arm that
  // the old 409 made impossible — a busy delegate could not be given the next instruction at all, so a
  // supervisor with something to say had to interrupt or wait.
  | { kind: "queue"; startsTurn: true }
  // Stop the current turn first, then start one for this message.
  | { kind: "abortThenStart" };

export function planDelivery(state: DelegateState, mode: DelegateDeliveryMode): DeliveryPlan {
  // A delegate that cannot be reached is a refusal for every mode, and the refusal NAMES ITS STATE — the
  // difference between "it errored", "you closed it" and "the control plane no longer holds it" is the
  // difference between three completely different next moves.
  switch (state.status) {
    case "errored":
      throw new ConflictError(
        "CONFLICT",
        { status: state.status },
        `This delegate stopped with an error and cannot take more input: ${state.message}`,
      );
    case "closed":
      throw new ConflictError(
        "CONFLICT",
        { status: state.status },
        "This delegate was closed. Its container is gone — open a new session rather than resuming this one.",
      );
    case "orphaned":
      throw new ConflictError(
        "CONFLICT",
        { status: state.status, since: state.since },
        `This delegate is no longer held by this control plane (${state.cause}). Nothing can be asked of it; read its trajectory for what it did before the connection was lost.`,
      );
    case "pending_init":
    case "completed":
    case "awaiting":
    case "interrupted":
      // Idle in four different ways, and identical for the purpose of delivery. A `completed` delegate taking
      // a follow-up is the point of keeping `completed` apart from `closed`: "that is nearly right, now do
      // this" must not require a new container and a fresh clone. An `awaiting` one is how the ANSWER gets
      // back — the delegate asked, and a `task` carrying the answer is the reply.
      return mode === "message" ? { kind: "queue", startsTurn: false } : { kind: "start" };
    case "running":
      switch (mode) {
        case "message":
          return { kind: "queue", startsTurn: false };
        case "task":
          return { kind: "queue", startsTurn: true };
        case "interrupt":
          return { kind: "abortThenStart" };
      }
  }
}

// What an interrupt records. Separated from `planDelivery` because interrupting is also something a
// supervisor does on its own — "stop, I am thinking" — with no message behind it, and both paths must write
// the same state or the two spellings of `interrupted` will disagree about what `previous` means.
export function interruptedFrom(state: DelegateState): Extract<DelegateState, { status: "interrupted" }>["previous"] {
  switch (state.status) {
    case "running":
      return "running";
    case "completed":
    case "awaiting":
      return "completed";
    case "pending_init":
      return "pending_init";
    // Interrupting something already interrupted keeps the ORIGINAL account of what was stopped. Overwriting
    // it with "interrupted" would turn a second stop into a record that says nothing about what was ever
    // running, and the first interrupt's reason is the one that explains the container's state.
    case "interrupted":
      return state.previous;
    case "errored":
    case "closed":
    case "orphaned":
      throw new ConflictError(
        "CONFLICT",
        { status: state.status },
        "There is no turn to interrupt — this delegate is no longer running.",
      );
  }
}
