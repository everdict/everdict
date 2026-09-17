import { z } from "zod";
import { DelegateReportSchema } from "./delegation-brief.js";

// ── HOW A SUPERVISOR REACHES A DELEGATE ──────────────────────────────────────────────────────────────
//
// There used to be one way, and it refused while the delegate was busy: submit a task, get `409 — a test case
// is already running`. That single door made three different intentions impossible to express, and the one it
// did express was the most disruptive of them.
//
// The three are distinguished by WHAT THEY DO TO THE DELEGATE'S CURRENT TURN, which is the only axis that
// matters to the delegate:
//
//   `message`   — lands in the mailbox and waits to be read. Does NOT start a turn and does not disturb one.
//                 "The API you are calling changed yesterday" belongs here: useful, not urgent, and derailing
//                 a delegate to say it costs more than it gives.
//   `task`      — work to do. Starts a turn if the delegate is idle; if it is mid-turn the message is
//                 delivered at the next boundary, so a busy delegate is a reason to pick a moment rather than
//                 a reason to refuse.
//   `interrupt` — stop what you are doing and handle this. The current turn is aborted first.
//
// ⚠️ `interrupt` ABORTS A TURN, NOT A RELATIONSHIP. The delegate stays alive with its container, its working
// directory and its conversation, and is immediately able to take the next message. Before this vocabulary
// existed the only way to stop a delegate going the wrong way was to close the session, which killed the
// container and every uncommitted change in it — so the cost of being wrong about "this is going badly" was
// the whole session, and the rational move was to wait and watch it finish.
export const DELEGATE_DELIVERY_MODES = ["message", "task", "interrupt"] as const;
export const DelegateDeliveryModeSchema = z.enum(DELEGATE_DELIVERY_MODES);
export type DelegateDeliveryMode = z.infer<typeof DelegateDeliveryModeSchema>;

// ── WHAT A DELEGATE IS RIGHT NOW ─────────────────────────────────────────────────────────────────────
//
// A union rather than a status string plus optional fields, so that the pairs which must travel together
// cannot come apart: a `completed` delegate has somewhere to put its report, an `errored` one cannot be
// recorded without saying what happened, and an `interrupted` one carries who stopped it.
//
// `completed` is NOT `closed`, and keeping them apart is what creates a review seam. A delegate that has
// finished stays addressable — its container alive, its report readable, able to take a follow-up — until the
// supervisor explicitly lets it go. Collapsing the two is what made the previous lane settle and seal at the
// end of a turn, leaving no state that means "done, and waiting for you to look".
export const DelegateStateSchema = z.discriminatedUnion("status", [
  // Booted, nothing asked of it yet.
  z.object({ status: z.literal("pending_init") }),
  // A turn is in flight. `turnRunId` is the child run carrying its trace.
  z.object({ status: z.literal("running"), turnRunId: z.string().min(1), startedAt: z.string() }),
  // Its turn was stopped and it may receive more input. `previous` is what it was doing when the interrupt
  // landed, because "I stopped it" and "I stopped it while it was already finishing" are different facts.
  z.object({
    status: z.literal("interrupted"),
    at: z.string(),
    by: z.string().min(1),
    reason: z.string().max(1000).optional(),
    previous: z.enum(["pending_init", "running", "completed"]),
  }),
  // Done, and waiting to be reviewed. The report is optional because a delegate can end a turn without
  // filing one — and a supervisor must be able to tell "finished without reporting" from "still running".
  z.object({ status: z.literal("completed"), at: z.string(), report: DelegateReportSchema.optional() }),
  z.object({ status: z.literal("errored"), at: z.string(), message: z.string().min(1).max(4000) }),
  z.object({ status: z.literal("closed"), at: z.string() }),
  // ⚠️ THE THIRD VALUE. The ledger has this session; this control plane does not hold it. A restart is the
  // ordinary cause: the container died with the process, so the work may have been finished, half-done or
  // never started and there is no longer anything to ask. It is NOT `closed` — that would claim an ending
  // nobody observed — and it must not be an absent row, which is how "no delegate is running" and "this
  // process forgot" became the same answer (rule `protocol` L2: unknown is unignorable).
  z.object({ status: z.literal("orphaned"), since: z.string(), cause: z.string().min(1).max(500) }),
]);
export type DelegateState = z.infer<typeof DelegateStateSchema>;

export type DelegateStatus = DelegateState["status"];

// A delegate is REACHABLE when a message can still arrive: it is alive on this control plane and has not been
// let go. Written once because the delivery gate, the read model and the wait loop each need the same answer,
// and three spellings of it would disagree the first time a state was added.
export function delegateIsReachable(state: DelegateState): boolean {
  switch (state.status) {
    case "pending_init":
    case "running":
    case "interrupted":
    case "completed":
      return true;
    case "errored":
    case "closed":
    case "orphaned":
      return false;
  }
}

// A delegate is SETTLED when the supervisor has nothing left to wait for. Deliberately not the negation of
// `delegateIsReachable`: a `completed` delegate is both settled AND reachable — that is the review seam, and a
// predicate that made it one or the other would erase it.
export function delegateIsSettled(state: DelegateState): boolean {
  switch (state.status) {
    case "pending_init":
    case "running":
      return false;
    case "interrupted":
    case "completed":
    case "errored":
    case "closed":
    case "orphaned":
      return true;
  }
}
