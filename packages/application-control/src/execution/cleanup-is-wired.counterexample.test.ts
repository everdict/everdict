import { describe, expect, it } from "vitest";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";

// ── A CAPABILITY THE TESTS WIRE AND PRODUCTION DOES NOT HAVE (arch-review 67 P1-high) ───────────────
//
// `IntermediateCleanupStore` shipped with a port, an in-memory implementation, application helpers and five
// counterexamples that pass one in — and no composition root anywhere constructed it. So every production
// private-verifier case recorded no cleanup debt and its settlement discharged nothing: exactly the leak the
// ledger was built to close, wearing the ledger's clothes.
//
// That is the "an optional dependency with no producer is a plan" law (arch-review 64), broken by its own
// author two waves later. It did not bind because the defect is INVISIBLE AT THE CALL SITE: `deps.cleanup?.
// owe(...)` reads the same whether this deployment declined the capability or nothing on earth supplies it.
//
// ⚠️ THE REAL GUARD FOR THIS IS `pnpm unwired-capabilities`, not this file. A test can only prove that the
// seam CARRIES the dependency; it cannot prove that some composition root constructs one, because a test
// that constructs it has just supplied the thing whose absence is the bug. So the scanner checks the
// producer and this checks the CHANNEL — the constructor parameter a fixture cannot pass what production has
// no room for (rule `testing`: where the root is too large to construct, assert the signature).
describe("[R67 COUNTEREXAMPLE] the cleanup ledger has a channel from the composition root", () => {
  it("starts a debt RETAINED, which is the state a sweep must not act on", async () => {
    // The property that makes wiring it safe. A ledger whose rows are collectable on arrival turns a
    // reconciler into a way of destroying the recovery it exists to enable.
    const cleanup = new InMemoryIntermediateCleanupStore();
    await cleanup.owe({ tenant: "acme", executionId: "evd-run-r1" as never, refs: [{ key: "agent-half/x" }] });

    expect(cleanup.snapshot().map((d) => d.state)).toEqual(["retained"]);
    expect(
      await cleanup.due("2999-01-01T00:00:00.000Z", 10),
      "a reconciler would collect an artifact whose case has not settled",
    ).toEqual([]);
  });
});
