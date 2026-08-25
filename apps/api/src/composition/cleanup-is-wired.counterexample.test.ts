import { InMemoryIntermediateCleanupStore } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import { VerifierAwareDispatcher } from "../core/execution/verifier-aware-dispatcher.js";

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
describe("[R67 COUNTEREXAMPLE] the cleanup ledger reaches the pass from the composition root", () => {
  it("records a debt when the production dispatcher runs a private-verifier case", async () => {
    // ⚠️ DRIVEN, NOT INSPECTED. The first version of this test constructed the dispatcher and asserted it had
    // STORED the ledger — which stays true when `dispatch()` forgets to pass it on, i.e. exactly the
    // value-never-received defect this repo turned `noUnusedLocals` on for. What has to be true is that the
    // pass RECEIVES it, so the dispatch is driven and the debt is read back.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const dispatcher = new VerifierAwareDispatcher(
      {
        dispatch: async () =>
          ({
            caseId: "c1",
            harness: "h@1",
            trace: [],
            scores: [],
            snapshot: { kind: "repo", diff: "", changedFiles: [], base: "b", headSha: "h" },
          }) as never,
      } as never,
      // A verifier lane IS required for anything to be staged: a half written for a verifier that never runs
      // is garbage the moment it is written, so the pass refuses before staging (arch-review 62). This one
      // errors, which is the ending that carries no receipt — the case the debt exists for.
      async () => {
        throw new Error("the verifier container crashed");
      },
      {
        async put(key: string) {
          return key;
        },
        async get() {
          return undefined;
        },
        async remove() {},
      },
      undefined,
      cleanup,
    );

    await dispatcher.dispatch({
      tenant: "acme",
      runId: "evd-run-r1",
      harness: { id: "h", version: "1" },
      evalCase: {
        id: "c1",
        task: "t",
        env: { kind: "repo", source: { path: "/app" } },
        // PRIVATE by its config carrying material the agent must not see — what makes a verifier plan at all.
        graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
        timeoutSec: 60,
        tags: [],
      },
    } as never);

    expect(
      cleanup
        .snapshot()
        .flatMap((d) => d.refs)
        .map((r) => r.key),
      "the pass staged an artifact that no ledger owes — the capability is wired in tests and absent in production",
    ).toHaveLength(1);
    expect(
      cleanup.snapshot().map((d) => d.state),
      "the debt arrived collectable rather than retained",
    ).toEqual(["retained"]);
  });
});
