import type { AdoptionOperation } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { AdoptionOperationStore } from "../ports/evolution-campaign-store.js";
import { completionFact, issueSettledThisAdoption } from "./adoption-completion.js";

// ── THE DURABLE OWNER OF A REGISTERED-BUT-UNDISCHARGED ADOPTION (arch-review 115) ───────────────────
//
// Two happy paths join a registration to its issue's resolution, and neither of them owns the debt when one
// of the two reads fails:
//
//   issue settles LAST   → `issue.status_changed` → adoptionCompletionWatch → markCompleted
//   issue settled FIRST  → the adopt call reads the issue inline right after markRegistered
//
// The inline read swallows its failure — correctly, because the registry effect has already landed and
// failing the caller would report a write that happened as one that did not — under a comment saying the
// operation "stays owed, which the reconciler and any later issue event both still converge on". There was
// no reconciler. And "any later issue event" only exists if the issue has not ALREADY closed, which is
// exactly the ordering the inline read exists for. Three ways to reach the stuck state:
//
//   · the issue read throws once, transiently;
//   · `adopt` is retried on a `registered` operation and answers `already_adopted` without re-joining;
//   · two adopters race, the winner registers and dies before the join, the loser sees `already_registered`.
//
// In all three the world is: registry version exists, issue done on the exact proving scorecard, operation
// `registered`, no future event coming. This sweep is what converges it.
//
// ⚠️ AN E1 CONSUMER IS NOT THIS OWNER. `EventConsumerRunner.deliver` retries a throwing handler three times
// INSIDE one delivery and then dead-letters, advancing the cursor — so an outage outlasting three immediate
// attempts loses the join for good. A consumer of `campaign.adoption_registered` would buy latency; only a
// worklist the store can re-offer buys convergence (rule `protocol` L5).
export interface AdoptionCompletionReconcilerDeps {
  operations: AdoptionOperationStore;
  // The same narrow read the adopt path uses. A failure here is UNKNOWN, never "not resolved": the operation
  // is left for the next sweep rather than being decided on a read that did not happen (L2).
  issues: { get(tenant: string, ref: string): Promise<{ status: string; resolution?: { scorecardId?: string } }> };
  now?: () => string;
  newId?: () => string;
  // How long an operation may sit `registered` before the sweep looks at it. Not zero: the ordinary path
  // completes within one call, and sweeping a row the adopt call is still inside would race it for no gain.
  minAgeMs?: number;
  limit?: number;
}

export interface AdoptionCompletionSweep {
  // What the sweep did, so the caller can log it. A sweep whose numbers nobody reads is a sweep nobody can
  // tell from one that never ran (arch-review 102).
  examined: number;
  completed: number;
  // Still owed: the issue is not done on this adoption's evidence. Not a failure — the campaign's issue is
  // simply still open.
  open: number;
  // Could not find out. The operation stays on the worklist; this is the escalation count, never a terminal.
  unknown: number;
}

export class AdoptionCompletionReconciler {
  constructor(private readonly deps: AdoptionCompletionReconcilerDeps) {}

  async sweep(): Promise<AdoptionCompletionSweep> {
    const now = this.deps.now?.() ?? new Date().toISOString();
    const olderThan = new Date(Date.parse(now) - (this.deps.minAgeMs ?? 60_000)).toISOString();
    const due = await this.deps.operations.registeredOlderThan(olderThan, this.deps.limit ?? 100);
    const out: AdoptionCompletionSweep = { examined: due.length, completed: 0, open: 0, unknown: 0 };
    for (const operation of due) {
      const outcome = await this.settle(operation, now);
      out[outcome] += 1;
    }
    return out;
  }

  private async settle(operation: AdoptionOperation, now: string): Promise<"completed" | "open" | "unknown"> {
    let issue: { status: string; resolution?: { scorecardId?: string } };
    try {
      issue = await this.deps.issues.get(operation.tenant, operation.proof.issueId);
    } catch {
      // Absent and unreadable are both "we could not decide from here". Neither may complete the operation,
      // and neither may remove it from the worklist — the next sweep asks again, and THIS sweep is the
      // component that comment names (rule `protocol`, comment-is-a-claim).
      return "unknown";
    }
    // The SAME predicate the watcher and the inline path consume — imported, never re-spelled: an issue
    // closed on other evidence is not this adoption discharging its intent (L3).
    if (!issueSettledThisAdoption(issue, operation.proof)) return "open";
    const outcome = await this.deps.operations.markCompleted(
      operation.tenant,
      operation.proof.campaignId,
      contentDigest(operation.proof),
      // The SAME fact both other writers author — one owner, three writers (arch-review 83).
      stampFacts(operation.tenant, [completionFact(operation)], {
        newId: this.deps.newId ?? (() => `evt_${Math.random().toString(36).slice(2, 12)}`),
        now: () => now,
      }).map((f) => f.record),
    );
    // The conditional write's ANSWER decides, not our read: `already_completed` means one of the other two
    // paths won the race, which is success; anything else means the row moved under us and the next sweep
    // re-reads it (L1 — a decision that rests on a conditional write consumes its answer).
    return outcome === "completed" || outcome === "already_completed" ? "completed" : "unknown";
  }
}
