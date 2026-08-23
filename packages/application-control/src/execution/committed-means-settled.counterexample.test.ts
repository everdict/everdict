import { runExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";

// ── `committed` CLAIMS A RESULT, SO IT ANSWERS TO THE PARENT (arch-review 62 P1) ─────────────────────
//
// The attempt states are not interchangeable terminals. `failed`, `revoked` and `superseded` CLOSE a row;
// `committed` says something stronger — this attempt's result is the case's answer. Reserving and activating
// have re-asked whether the parent still authorizes them since arch-review 56, precisely because a proof has
// a lifetime. The write that actually claims the outcome did not ask at all:
//
//     verifier container finishes, verdict in hand
//     cancellation settles the batch underneath it
//     transition(attempt, "committed") → true
//
// So the ledger holds a `committed` attempt for a settlement that had already closed without it. Nothing
// crashes; the physical plane simply records a measurement that no decision ever consumed, and every reader
// asking "which attempt produced this case's answer" is told about one that did not.
//
// ONLY `committed` is gated. Refusing the other three under a terminal parent would leave rows reading live
// forever — a teardown chasing containers that are gone, which is the debt L5 exists to prevent — and none
// of them asserts that anything was measured.
//
// Seen RED before the guard, observed:
//   an attempt claimed the case's answer after its parent had already settled without it: expected true to
//   be false

// A parent that starts open and can be closed mid-flight, which is the whole interleaving.
function parentThat(open: () => boolean) {
  return {
    authorityOf: async () => (open() ? { epoch: 1 } : undefined),
  };
}

describe("[R62 COUNTEREXAMPLE] an attempt cannot claim the answer of a settlement that closed without it", () => {
  const opened = async (parentOpen: () => boolean) => {
    const attempts = new InMemoryExecutionAttemptStore(undefined, parentThat(parentOpen));
    const { attemptId } = await attempts.open({ executionId: runExecutionId("r1"), tenant: "acme" });
    await attempts.reserveWork(attemptId, { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-verify-1" });
    return { attempts, attemptId };
  };

  it("REFUSES committed once the parent has settled", async () => {
    let open = true;
    const { attempts, attemptId } = await opened(() => open);
    open = false; // the cancellation lands while the container is finishing

    const claimed = await attempts.transition(attemptId, "committed");
    expect(claimed, "an attempt claimed the case's answer after its parent had already settled without it").toBe(false);
    const [row] = await attempts.list(runExecutionId("r1"));
    expect(row?.state, "the row was moved anyway, so the refusal was only a return value").toBe("reserved");
  });

  it("still allows FAILED under a settled parent — closing a row is not claiming a result", async () => {
    // The other half, and the one that would turn this guard into a worse bug than it fixes: an attempt that
    // cannot settle at all reads as live work forever, and the teardown above it never converges.
    let open = true;
    const { attempts, attemptId } = await opened(() => open);
    open = false;

    expect(
      await attempts.transition(attemptId, "failed", { error: { code: "UPSTREAM_ERROR", message: "gone" } }),
      "an attempt under a settled parent could not close, so it reads as live work forever",
    ).toBe(true);
    const [row] = await attempts.list(runExecutionId("r1"));
    expect(row?.state).toBe("failed");
  });

  it("still allows REVOKED under a settled parent — that is what a cancellation does", async () => {
    let open = true;
    const { attempts, attemptId } = await opened(() => open);
    open = false;
    expect(await attempts.transition(attemptId, "revoked")).toBe(true);
  });

  it("COMMITS normally while the parent is still open", async () => {
    // The control: a guard that refused every commit would satisfy the first assertion and stop the product.
    const { attempts, attemptId } = await opened(() => true);
    expect(await attempts.transition(attemptId, "committed"), "an ordinary verdict could not be settled").toBe(true);
    const [row] = await attempts.list(runExecutionId("r1"));
    expect(row?.state).toBe("committed");
  });

  it("COMMITS when no parent authority is wired at all", async () => {
    // A deployment that supplies no parent reader is the single-store case, not a deployment where every
    // commit is refused. Absence of a check is not a failed check.
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: runExecutionId("r2"), tenant: "acme" });
    expect(await attempts.transition(attemptId, "committed")).toBe(true);
  });
});
