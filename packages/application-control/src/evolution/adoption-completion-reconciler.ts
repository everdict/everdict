import type { AdoptionOperation } from "@everdict/contracts";
import { NotFoundError } from "@everdict/contracts";
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
  // How long an operation whose ISSUE IS GONE waits before it is examined again. Long by default: no sweep
  // can change its answer, so re-reading it every five minutes is work that produces one number an operator
  // already has. Not infinite, because an issue can be restored and the debt is still owed.
  orphanBackoffMs?: number;
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
  // ── AND THE ONE THAT WILL NEVER CONVERGE (arch-review 116, self-review) ─────────────────────────
  //
  // The first version of this sweep caught every throw as `unknown`, and `IssueService.get` throws
  // `NotFoundError` for an issue that no longer exists. `DELETE /issues/:id` is a real route, so an adoption
  // whose issue was deleted sat on the worklist being re-examined every five minutes forever and reported as
  // "unreadable" — which reads as a transient outage an operator should wait out.
  //
  // Absent and unreadable are the two states L2 exists to keep apart, and here they differ in what an
  // operator must DO: one resolves itself, the other never will. Counted separately so the difference is
  // visible rather than buried in a number that only grows.
  orphaned: number;
  // ── AND THE ROWS THE DEFERRAL DID NOT MOVE (arch-review 120, self-review) ───────────────────────
  //
  // `deferCompletion` is a CONDITIONAL write — `WHERE … state = 'registered' RETURNING operation_id` — and
  // its boolean was discarded by this file, its only caller. A `false` has two readings and they are not
  // alike: the row legitimately left `registered` between the read and the write (another replica finished
  // it — benign), or the statement matched nothing it should have matched, in which case NO deferral ever
  // lands, the backoff this sweep was written for never applies, and the same rows hold the head of the
  // worklist forever with nothing to see. That is the always-succeeds double's mirror image, at the caller:
  // a store that answers honestly and a caller that does not look (rule `protocol`).
  //
  // Counted, not thrown: one un-deferred row is ordinary, and a number that climbs sweep after sweep is the
  // signal. It rides on the struct the sweep already returns for exactly this reason.
  undeferred: number;
}

export class AdoptionCompletionReconciler {
  constructor(private readonly deps: AdoptionCompletionReconcilerDeps) {}

  async sweep(): Promise<AdoptionCompletionSweep> {
    const now = this.deps.now?.() ?? new Date().toISOString();
    const olderThan = new Date(Date.parse(now) - (this.deps.minAgeMs ?? 60_000)).toISOString();
    const due = await this.deps.operations.registeredOlderThan(olderThan, this.deps.limit ?? 100);
    const out: AdoptionCompletionSweep = {
      examined: due.length,
      completed: 0,
      open: 0,
      unknown: 0,
      orphaned: 0,
      undeferred: 0,
    };
    for (const operation of due) {
      const outcome = await this.settle(operation, now);
      out[outcome] += 1;
      // ── AND THE ROW GETS OUT OF THE WAY (arch-review 120) ────────────────────────────────────────
      //
      // Nothing this sweep does to a row it could not complete moved its position in the worklist, and the
      // worklist was oldest-first — so a hundred operations whose issue is still open, or whose issue was
      // DELETED and never will be, held the head of the list on every sweep while a newer completable one
      // was never read. The reconciler ran, reported, and converged nothing.
      //
      //     a periodic owner exists   ≠   every debt receives a turn
      //
      // A row that could not finish says WHEN to look again, and the interval says WHY:
      //   open      the issue is simply not done — ask again next sweep
      //   unknown   the read failed — back off, because a store that just refused will likely refuse again
      //   orphaned  the issue is GONE and no sweep can change that — far out, so it stops crowding the head
      //             while staying visible as the escalation it is (L5: never a terminal that hides the debt)
      // The deferral's own answer is CONSUMED: a write that did not land must not read as one that did.
      if (outcome !== "completed" && !(await this.defer(operation, outcome, now))) out.undeferred += 1;
    }
    return out;
  }

  // How far out each unfinished outcome goes. Deliberately plain arithmetic rather than a policy object: the
  // only property that matters is that an unfinishable row cannot hold the head of the list, and a number a
  // reader can check beats a knob nobody sets.
  private async defer(
    operation: AdoptionOperation,
    outcome: "open" | "unknown" | "orphaned",
    now: string,
  ): Promise<boolean> {
    const base = this.deps.minAgeMs ?? 60_000;
    const wait =
      outcome === "orphaned"
        ? (this.deps.orphanBackoffMs ?? 24 * 60 * 60_000) // a day: visible, and out of the working set
        : outcome === "unknown"
          ? base * 4 // a read that failed will likely fail again in the next few seconds
          : base; // the issue is open — nothing is wrong, ask again on the ordinary cadence
    return await this.deps.operations.deferCompletion({
      tenant: operation.tenant,
      campaignId: operation.proof.campaignId,
      outcome,
      nextAttemptAt: new Date(Date.parse(now) + wait).toISOString(),
    });
  }

  private async settle(
    operation: AdoptionOperation,
    now: string,
  ): Promise<"completed" | "open" | "unknown" | "orphaned"> {
    let issue: { status: string; resolution?: { scorecardId?: string } };
    try {
      issue = await this.deps.issues.get(operation.tenant, operation.proof.issueId);
    } catch (err) {
      // Neither answer may complete the operation or remove it from the worklist — but they are not the same
      // answer. An issue that is GONE can never discharge this intent, so re-examining it every sweep and
      // reporting "unreadable" tells an operator to wait for something that will not happen. A read that
      // FAILED is the third value this sweep exists to keep owed (L2).
      return err instanceof NotFoundError ? "orphaned" : "unknown";
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
