import { describe, expect, it } from "vitest";
import { type ActivationDecision, decideActivation } from "./dispatch-activation.js";

// ── A RESERVATION IS A CAPABILITY WITH A LIFETIME (arch-review 57 P0) ────────────────────────────────
//
// arch-review 54 put the reservation BEFORE the external effect: a control plane that dies between them no
// longer leaves a running Job nothing can address. arch-review 56 made a re-offered reservation re-check the
// parent, so the same work id cannot be handed back under a cancelled run.
//
// Neither closes the window INSIDE one dispatch. The caller that won the first reservation holds a proof with
// no expiry, and nothing re-consumes it before the external object is created:
//
//   driver A   reserve W  → ok
//              …pause (GC, a slow API, a rescheduled pod)
//   cancel     parent CANCELLED · finds W on the ledger · kill W → absent · probe W → absent
//              children terminal · cancellation COMPLETED
//   driver A   wakes · applyJob(W)
//
// The exact-absence probe arch-review 56 added proves absence AT THE MOMENT IT READ. It cannot prove that no
// new work is born afterwards, and the same-id re-check does not help either: A is not asking for a new
// reservation, it is spending the one it already has. So a cancellation that verified zero live work is
// followed by live work, which is precisely what "completion is verified zero" (rule `protocol` L5) forbids.
//
// The attempt vocabulary cannot even express the middle: `created · reserved · executing · committed ·
// superseded · failed`. There is no state that means "about to create the external object" and none that
// means "revoked before it did", so a cancellation has nothing to CAS against and a dispatch has nothing to
// re-present.
//
// RED as of 9d67491d, observed:
//   Cannot find module './dispatch-activation.js'
//
// This pins the DECISION — what a dispatch is allowed to do given the attempt's state at activation time.
// Wiring it into the two managed lanes is the effect on top of it.

const decide = (over: Parameters<typeof decideActivation>[0]): ActivationDecision => decideActivation(over);

describe("[R57 COUNTEREXAMPLE] a reserved dispatch re-proves its authority before it creates external work", () => {
  it("activates when the attempt is still the one that reserved this exact work", () => {
    expect(decide({ state: "reserved", recordedWork: "job-1", work: "job-1", parentOpen: true })).toEqual({
      kind: "activate",
    });
  });

  it("REFUSES after the attempt was revoked — the cancellation already certified zero live work", () => {
    // The whole point. A cancellation that read absence and completed must not be followed by a birth.
    expect(decide({ state: "revoked", recordedWork: "job-1", work: "job-1", parentOpen: false })).toMatchObject({
      kind: "refuse",
    });
  });

  it("REFUSES when the parent is no longer open, whatever the attempt row says", () => {
    // Cancellation revokes the SUBJECT's authority to author new external work (rule `protocol` L5). A row
    // the sweep has not reached yet is not permission.
    expect(decide({ state: "reserved", recordedWork: "job-1", work: "job-1", parentOpen: false })).toMatchObject({
      kind: "refuse",
    });
  });

  it("REFUSES a dispatch whose work is not the work this attempt reserved", () => {
    // A reservation authorizes ONE external object. Spending it on another is how a caller creates compute
    // nothing on the ledger addresses.
    expect(decide({ state: "reserved", recordedWork: "job-1", work: "job-2", parentOpen: true })).toMatchObject({
      kind: "refuse",
    });
  });

  it("is IDEMPOTENT for the same work already activated — a retried apply is not a second birth", () => {
    // At-least-once delivery is normal: the same dispatch re-driven must reach the same object, not a new one.
    expect(decide({ state: "active", recordedWork: "job-1", work: "job-1", parentOpen: true })).toEqual({
      kind: "already_active",
    });
  });

  it("REFUSES to re-activate a settled attempt", () => {
    for (const state of ["committed", "failed", "superseded"] as const)
      expect(decide({ state, recordedWork: "job-1", work: "job-1", parentOpen: true }), state).toMatchObject({
        kind: "refuse",
      });
  });

  it("REFUSES an attempt that never reserved anything", () => {
    // `created` means the row exists; it does not mean a work id was ever claimed for it.
    expect(decide({ state: "created", recordedWork: undefined, work: "job-1", parentOpen: true })).toMatchObject({
      kind: "refuse",
    });
  });
});
