import { ConflictError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { PlatformEventConsumer } from "../platform-event/event-consumer-runner.js";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";

// ── THE DECISION AND ITS INTENT, REJOINED (arch-review 73) ───────────────────────────────────────────
//
// arch-review 71 enumerated four states a campaign could reach silently, and closed three of them. The
// fourth was `adopted, issue unresolved` — the decision and the reason it was made coming apart — and it
// stayed open because `completed` was in the operation's state vocabulary with NO WRITER anywhere. A state
// nobody writes is not a lifecycle; it is a word.
//
// This is that writer. It reacts to `issue.status_changed` through the durable-cursor consumer (E1), the
// same at-least-once delivery the regression watch rides.
//
//     decided     the gate authorized it
//     registered  a registry write presented the proof and landed
//     completed   the ISSUE this campaign was opened against closed ON THIS ADOPTION'S EVIDENCE
//
// The last clause is the whole check, and it is why this cannot simply be "the issue went to done". An issue
// can be resolved by a scorecard that has nothing to do with the campaign — a different fix landed first, a
// member closed it by hand, a sibling campaign proved something else. Completing the operation on that would
// record that this adoption discharged an intent it did not, which is exactly the re-derivation rule
// `protocol` L3 forbids: the join is the SCORECARD the proof names, not the fact that some resolution
// happened nearby.
//
// Facts, not judgments: this says "the issue closed citing the scorecard this adoption proved". It does not
// claim the capability is good, or that nothing will regress — the regression watch is what reopens the
// issue later, and that transition leaves the operation `completed`, because it WAS completed. History is
// not rewritten by what happened next.
export interface AdoptionCompletionWatchDeps {
  operations: AdoptionOperationStore;
}

export function adoptionCompletionWatch(deps: AdoptionCompletionWatchDeps): PlatformEventConsumer {
  return {
    name: "evolution:adoption-completion",
    kinds: ["issue.status_changed"],
    async handle(event) {
      const payload = event.payload as { to?: unknown; scorecardId?: unknown };
      if (payload.to !== "done") return;
      // A resolution with no scorecard closed the issue on something other than measured evidence. That is a
      // legitimate way to close an issue and it is not this adoption's completion — absence is not a match.
      const resolvedBy = payload.scorecardId;
      if (typeof resolvedBy !== "string") return;
      const operations = await deps.operations.forIssue(event.tenant, event.subject.id);
      for (const operation of operations) {
        // An early-out, NOT the guard: the authority is `markCompleted`'s conditional write, which refuses
        // anything that is not `registered` inside the statement where atomicity matters. Neutralizing this
        // line changes nothing observable, and saying so is the point — an unspent authorization must not be
        // recorded as having settled its intent, and the store is what enforces that.
        if (operation.state !== "registered") continue;
        if (operation.proof.provingScorecardId !== resolvedBy) continue;
        // ── AND ITS ANSWER IS CONSUMED (arch-review 74, self-review) ──────────────────────────────────
        //
        // The first draft awaited this and discarded the result, under a comment saying the answer was
        // consumed. That is this file's own comment-is-a-claim law, in code twenty minutes old: a
        // conditional write exists to refuse, and a caller that never looks has turned `proof_mismatch` and
        // `no_such_operation` — the two answers that mean the ledger disagrees with what we just read —
        // into silence (rule `protocol` L1/L2).
        //
        // `completed` and `already_completed` are both success: at-least-once delivery means the second
        // arrival SHOULD find it done. `not_registered` is a live race with the adopt path (the row moved
        // between our read and this write) and the next delivery re-reads it. The remaining two are a
        // disagreement no retry fixes by itself, so they THROW — the E1 runner retries three times and then
        // dead-letters visibly, which is the escalation L5 asks for rather than a decision made by silence.
        const outcome = await deps.operations.markCompleted(
          event.tenant,
          operation.proof.campaignId,
          contentDigest(operation.proof),
        );
        if (outcome === "proof_mismatch" || outcome === "no_such_operation")
          throw new ConflictError(
            "CONFLICT",
            { campaign: operation.proof.campaignId, issue: event.subject.id, outcome },
            `the adoption this issue resolved could not be discharged (${outcome}) — the operation read for this issue is not the one the ledger holds`,
          );
      }
    },
  };
}
