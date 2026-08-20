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
  it("the run service hands over BOTH halves of the dispatch authority", () => {
    // Counting `onActivate` against `onReserved` was the right test for a contract with two optional hooks.
    // That contract is gone: arch-review 58's W2 merged them into one capability precisely because a
    // forwarding chain kept dropping the second one — the Scheduler's own allowlist, whose comment warned
    // that it is "the ONE place a hook can silently die", did exactly that to `onActivate`.
    //
    // So the property is now that the supplier answers both questions. A composition that reached the store
    // for one and not the other cannot type check, which is the point; what a source read still adds is that
    // the supplier is REAL — both halves reach the ledger's own conditional writes rather than being
    // satisfied with a literal.
    const source = readFileSync(RUN_SERVICE, "utf8");
    expect(source, "the run service supplies no dispatch authority at all").toContain("authority: {");
    expect(source, "the reservation half does not reach the ledger").toContain("this.reserveWork(");
    expect(source, "the activation half does not reach the ledger").toContain("this.activateWork(");
  });

  it("the activation supplier reaches the attempt store's conditional transition", () => {
    // Not just any function: the hook has to end at `activateWork`, which is the ONE statement that asserts
    // state, work id and parent authority together. A supplier that answered `{kind:"activate"}` from a plain
    // read would restore the very gap it exists to close.
    const source = readFileSync(RUN_SERVICE, "utf8");
    expect(source, "the activation hook does not reach the store's conditional transition").toContain("activateWork(");
  });
});
