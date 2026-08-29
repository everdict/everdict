import type { AdoptionOperation } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { AdoptionCompletionReconciler } from "./adoption-completion-reconciler.js";

// ── [R120 COUNTEREXAMPLE] A DEFERRAL THAT DID NOT LAND IS NOT ONE THAT DID ──────────────────────────
//
// `deferCompletion` is a CONDITIONAL write — `WHERE … state = 'registered' RETURNING operation_id` — and it
// answers `false` when the statement matched nothing. Its only caller discarded that answer:
//
//     if (outcome !== "completed") await this.defer(operation, outcome, now);   // ← the boolean, dropped
//
// which is the always-succeeds double's mirror image, at the caller: the store answers honestly and nobody
// looks. It matters because the deferral is the whole point of the sweep that introduced it — a row that
// could not finish must move out of the oldest-first worklist's head. If no deferral ever lands, the same
// rows are re-examined every pass forever, the newer completable ones are never reached, and the sweep
// reports a tidy set of counters the entire time.
//
// Seen RED before the fix: "a write that never landed was counted as a deferral: expected 0 to be 2".
const operation = (campaignId: string): AdoptionOperation =>
  ({
    tenant: "acme",
    state: "registered",
    updatedAt: "2026-01-01T00:00:00.000Z",
    proof: { campaignId, issueId: `iss_${campaignId}`, scorecardId: "sc-1" },
  }) as unknown as AdoptionOperation;

describe("[R120 COUNTEREXAMPLE] the reconciler consumes its deferral's answer", () => {
  it("counts the rows whose deferral matched nothing, instead of reporting a clean sweep", async () => {
    const deferrals: string[] = [];
    const reconciler = new AdoptionCompletionReconciler({
      operations: {
        async registeredOlderThan() {
          return [operation("c1"), operation("c2")];
        },
        // The REAL store's refusal, modelled the way a double honestly can: the statement matched nothing.
        // A double hard-coded to `true` here would make this file green over the defect it exists to pin.
        async deferCompletion(input: { campaignId: string }) {
          deferrals.push(input.campaignId);
          return false;
        },
      } as never,
      // Both issues are still open, so neither operation completes and both must be deferred.
      issues: {
        async get() {
          return { status: "in_progress" };
        },
      },
      now: () => "2026-02-01T00:00:00.000Z",
    });

    const sweep = await reconciler.sweep();

    // The premise: the sweep really did try to defer both. Without this the assertion below is satisfied by
    // a sweep that never called the store at all.
    expect(deferrals, "the sweep never attempted a deferral, so this proves nothing").toEqual(["c1", "c2"]);
    expect(sweep.open, "the outcomes were misread").toBe(2);
    expect(sweep.undeferred, "a write that never landed was counted as a deferral").toBe(2);
  });

  it("counts zero when every deferral landed — the control", async () => {
    const reconciler = new AdoptionCompletionReconciler({
      operations: {
        async registeredOlderThan() {
          return [operation("c1")];
        },
        async deferCompletion() {
          return true;
        },
      } as never,
      issues: {
        async get() {
          return { status: "in_progress" };
        },
      },
      now: () => "2026-02-01T00:00:00.000Z",
    });
    const sweep = await reconciler.sweep();
    expect(sweep.undeferred, "a landed deferral was reported as lost").toBe(0);
  });
});
