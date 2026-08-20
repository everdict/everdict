import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── AN OPTIONAL HOOK NOBODY SUPPLIES IS NOT A PROTOCOL (arch-review 58 P0) ──────────────────────────
//
// arch-review 57 added the activation state machine: `active`, `revoked`, `activateWork()` as a conditional
// transition, `requireActivation()` at the seam where each managed lane creates its external object. Every
// piece is there and tested.
//
// And nothing supplies it. `requireActivation(job, work, options?.onActivate)` returns immediately when the
// hook is absent, and a repository search finds `onActivate` only in the declaration, the helper, and the two
// backend consumers. So the production flow is exactly what it was before that wave:
//
//     onReserved  → durable reservation
//     onActivate  → absent → requireActivation is a no-op
//     external submit
//
// The optional hook is the shape that let this happen — the same shape rule `protocol` L1 names: "an optional
// pre-effect hook is a request; a required proof parameter is a protocol". A composition that forgets it type
// checks, and the omission is invisible at the call site because there is nothing there to see.
//
// So this is a STRUCTURAL check, not a behavioural one. A behavioural test would need a live cluster to prove
// the negative; what actually went wrong is that the dispatch options literal in the run service does not
// mention `onActivate`, and that is readable from the source.
//
// RED as of 26147830, observed:
//   the run service supplies onReserved but never onActivate — the activation transition has no producer

const RUN_SERVICE = join(import.meta.dirname, "run-service.ts");

describe("[R58 COUNTEREXAMPLE] the activation transition has a production producer", () => {
  it("the run service supplies onActivate wherever it supplies onReserved", () => {
    const source = readFileSync(RUN_SERVICE, "utf8");
    const reservations = source.split("onReserved:").length - 1;
    const activations = source.split("onActivate:").length - 1;

    expect(reservations, "this test is pinned to a call site that no longer exists").toBeGreaterThan(0);
    expect(
      activations,
      `the run service supplies onReserved ${reservations}× and onActivate ${activations}× — a dispatch that reserves without activating spends a proof nobody re-checked, which is the window arch-review 57 closed`,
    ).toBeGreaterThanOrEqual(reservations);
  });

  it("the activation supplier reaches the attempt store's conditional transition", () => {
    // Not just any function: the hook has to end at `activateWork`, which is the ONE statement that asserts
    // state, work id and parent authority together. A supplier that answered `{kind:"activate"}` from a plain
    // read would restore the very gap it exists to close.
    const source = readFileSync(RUN_SERVICE, "utf8");
    expect(source, "the activation hook does not reach the store's conditional transition").toContain("activateWork(");
  });
});
