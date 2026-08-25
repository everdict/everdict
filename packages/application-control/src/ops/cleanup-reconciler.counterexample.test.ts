import type { ExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import { IntermediateCleanupReconciler, cleanupRemover } from "./intermediate-cleanup-reconciler.js";

// ── THE DEBT OUTLIVES THE PROCESS THAT INCURRED IT (arch-review 68) ────────────────────────────────
//
// The settlement discharges inline, which covers every case that settles in the process that ran it. The
// reason the ledger exists is the other case: a control plane that dies between the staging and the
// settlement, or a delete that did not converge. Both leave a row saying "these bytes are garbage" and
// nobody looking at it.
//
// ⚠️ AND THE SAFETY PROPERTY IS THE ONE THAT MATTERS MORE THAN THE LIVENESS ONE. A sweep that could see
// RETAINED rows would delete the artifact a crashed case is about to be recovered from — turning the ledger
// into a way of destroying the recovery it was built to enable. That is not a hypothetical: the first
// version of this ledger wrote every debt as `owed` (the state meaning DELETE THIS) from the moment the
// bytes were staged, and nothing removed them only because no reconciler existed yet. This is that
// reconciler.
//
// Seen RED with `due()` returning retained rows, observed:
//   the sweep deleted an artifact whose case has not settled: expected [ 'agent-half/…' ] to have a length of 1

const EXECUTION = "evd-run-r1" as ExecutionId;
const OTHER = "evd-run-r2" as ExecutionId;

function objectStore(keys: string[]) {
  return {
    keys,
    async remove(key: string) {
      const i = keys.indexOf(key);
      if (i >= 0) keys.splice(i, 1);
    },
  };
}

// A staged artifact, in the two steps production takes: the debt is recorded BEFORE the put and confirmed
// after it, so a crash between them leaves a row pointing at bytes that may not exist.
const stage = async (cleanup: InMemoryIntermediateCleanupStore, executionId: ExecutionId, key: string) => {
  await cleanup.owe({ tenant: "acme", executionId, refs: [{ key, digest: "sha256:x" }] });
  await cleanup.confirm({ tenant: "acme", executionId, keys: [key] });
};

describe("[R68 COUNTEREXAMPLE] the cleanup reconciler collects only what a settlement released", () => {
  it("NEVER touches an artifact whose case has not settled", async () => {
    // The safety property. Everything below is liveness; this is the one that makes the sweep safe to run at
    // all, and the one the previous ledger shape would have failed.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const objects = objectStore(["agent-half/acme/evd-run-r1/sha256:half.json"]);
    await stage(cleanup, EXECUTION, objects.keys[0] ?? "");

    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: objects }),
    }).tick();

    expect(tick.claimed, "the sweep claimed a retained debt").toBe(0);
    expect(objects.keys, "the sweep deleted an artifact whose case has not settled").toHaveLength(1);
    expect(cleanup.snapshot().map((d) => d.state)).toEqual(["retained"]);
  });

  it("COLLECTS what the settlement released, after the process that staged it is gone", async () => {
    // The whole point: this store outlives the staging process, so the sweep is a different run of a
    // different process reading a row it did not write.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const objects = objectStore(["agent-half/acme/evd-run-r1/sha256:half.json", "verifier-verdict/acme/x.json"]);
    await stage(cleanup, EXECUTION, objects.keys[0] ?? "");
    await stage(cleanup, EXECUTION, objects.keys[1] ?? "");
    // The settlement ran and released; then everything about that process is gone.
    await cleanup.releaseForGc("acme", EXECUTION);

    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: objects, verdicts: objects }),
    }).tick();

    expect(tick, "the released debt was not collected").toEqual({ claimed: 1, completed: 1, deferred: 0 });
    expect(objects.keys, "the sweep left the released artifacts in storage").toEqual([]);
    expect(cleanup.snapshot().map((d) => d.state)).toEqual(["completed"]);
  });

  it("HOLDS the debt open when a delete does not converge, with the error and a backoff", async () => {
    // "We could not find out" is an escalation field, never a terminal (rule `protocol` L5). A sweep that
    // marked this done would lose the object AND the record of it in one step.
    const cleanup = new InMemoryIntermediateCleanupStore();
    await stage(cleanup, EXECUTION, "agent-half/acme/evd-run-r1/sha256:half.json");
    await cleanup.releaseForGc("acme", EXECUTION);

    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      now: () => "2026-08-25T00:00:00.000Z",
      remove: async () => {
        throw new Error("the object store is unreachable");
      },
    }).tick();

    expect(tick).toEqual({ claimed: 1, completed: 0, deferred: 1 });
    const [debt] = cleanup.snapshot();
    expect(debt?.state, "an unconverged delete marked the debt paid").toBe("retry_wait");
    expect(debt?.attempts).toBe(1);
    expect(debt?.lastError).toContain("unreachable");
    expect(debt?.nextAttemptAt, "the debt came back immediately instead of backing off").toBe(
      "2026-08-25T00:01:00.000Z",
    );
    // …and it is not due again until the backoff elapses, which is what makes the retry a retry.
    expect(await cleanup.due("2026-08-25T00:00:30.000Z", 10)).toEqual([]);
    expect((await cleanup.due("2026-08-25T00:02:00.000Z", 10)).length).toBe(1);
  });

  it("HOLDS a ref whose write was never confirmed, rather than counting a missing key deleted", async () => {
    // ⚠️ THE SUBTLE ONE. `owe` records the debt BEFORE the put — deliberately, so a crash between them leaves
    // something to find — which means a ref can name bytes that do not exist. Deleting an absent key
    // "succeeds" on every object store, so counting it done would let this sweep complete a debt whose put is
    // still in flight behind it, orphaning exactly the object the row exists to protect.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const objects = objectStore([]);
    // Owed but never confirmed: the crash happened between the two.
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [{ key: "agent-half/acme/x.json" }] });
    await cleanup.releaseForGc("acme", EXECUTION);

    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: objects }),
    }).tick();

    expect(tick.completed, "a debt whose write never landed was marked collected").toBe(0);
    expect(tick.deferred).toBe(1);
    expect(cleanup.snapshot()[0]?.lastError).toContain("never confirmed");
  });

  it("collects each execution's debt independently", async () => {
    // The control: one execution's unconverged delete must not hold another's debt open, and a released debt
    // must not reach into a retained one's objects.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const objects = objectStore(["agent-half/acme/evd-run-r1/a.json", "agent-half/acme/evd-run-r2/b.json"]);
    await stage(cleanup, EXECUTION, "agent-half/acme/evd-run-r1/a.json");
    await stage(cleanup, OTHER, "agent-half/acme/evd-run-r2/b.json");
    await cleanup.releaseForGc("acme", EXECUTION);

    await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: objects }),
    }).tick();

    expect(objects.keys, "the sweep collected an execution whose case had not settled").toEqual([
      "agent-half/acme/evd-run-r2/b.json",
    ]);
  });
});
