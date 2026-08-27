import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";

// ── A SWEEP DECIDES ON A SNAPSHOT AND COMMITS WITHOUT RE-READING IT (arch-review 72 P1-high) ────────
//
// arch-review 71 closed the direct race: a `confirm` arriving after the debt was completed re-opens the row.
// It could not close this one, which is the same window one step earlier.
//
//     writer      owe(K), written=false, PAUSED before the put
//     settlement  retained → gc_owed
//     reconciler  due() → snapshot holds K
//                 probe K → absent → classify ABANDONED
//     writer      resumes: put(K) lands, confirm(K) → row is gc_owed, K.written=true
//     reconciler  complete(tenant, executionId)      ← decided on the OLD snapshot
//
//     object K exists · row completed · no future sweep
//
// `complete` guarded only on `state IN ('gc_owed','retry_wait')`, and the row IS in one of those states —
// the writer's confirm put it back there. The guard is about the wrong thing: what changed is the REFS, and
// nothing compared them.
//
// A snapshot plus an external probe is a decision about a moment. Committing it needs the row to still be
// the moment it was read (rule `protocol` L1: a proof has a lifetime, and the write re-proves it).
//
// So the row carries a monotonic `revision`, every mutation bumps it, and `complete` is conditional on the
// revision the sweep decided over. A writer that moved the row makes the completer stale, and the next tick
// re-evaluates every ref including the one that just landed.
//
// Seen RED before the revision guard, observed:
//   a stale sweep completed a debt whose bytes had just landed: expected 'completed' to be 'gc_owed'

const EXECUTION = storedExecutionId("evd-run-r1");
const KEY = "agent-half/paused.json";
const ref = { key: KEY, digest: "sha256:k" };

describe("[R72 COUNTEREXAMPLE] a completer that decided on an old snapshot is refused", () => {
  it("REFUSES to complete after the writer changed the row", async () => {
    const cleanup = new InMemoryIntermediateCleanupStore();
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref] });
    await cleanup.releaseForGc("acme", EXECUTION);

    // The sweep reads its worklist and decides over THIS revision.
    const snapshot = (await cleanup.due(new Date(Date.now() + 60_000).toISOString(), 50))[0];
    expect(snapshot, "the sweep had no work, so this measures nothing").toBeDefined();
    if (snapshot === undefined) return;
    const decidedOver = snapshot.revision;

    // …and while it was probing the object store, the paused writer woke up and its put landed.
    await cleanup.confirm({ tenant: "acme", executionId: EXECUTION, keys: [KEY] });

    const outcome = await cleanup.complete("acme", EXECUTION, decidedOver);

    expect(outcome, "a stale sweep completed a debt whose bytes had just landed").toBe("changed");
    const after = cleanup.snapshot()[0];
    expect(after?.state, "the row was closed over an object that exists").toBe("gc_owed");
    // …and the ref is now confirmed, so the NEXT sweep deletes it instead of abandoning it.
    expect(after?.refs[0]?.written).toBe(true);
  });

  it("COMPLETES when nothing moved under it", async () => {
    // The ordinary path, and the control: a revision guard that refused everything would be a cleanup that
    // never converges.
    const cleanup = new InMemoryIntermediateCleanupStore();
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref] });
    await cleanup.confirm({ tenant: "acme", executionId: EXECUTION, keys: [KEY] });
    await cleanup.releaseForGc("acme", EXECUTION);

    const snapshot = (await cleanup.due(new Date(Date.now() + 60_000).toISOString(), 50))[0];
    if (snapshot === undefined) throw new Error("no work");

    expect(await cleanup.complete("acme", EXECUTION, snapshot.revision)).toBe("completed");
    expect(cleanup.snapshot()[0]?.state).toBe("completed");
  });

  it("says ABSENT for an execution with no debt", async () => {
    const cleanup = new InMemoryIntermediateCleanupStore();
    expect(await cleanup.complete("acme", EXECUTION, 1)).toBe("absent");
  });

  it("bumps the revision on every mutation, so a stale reader is always detectable", async () => {
    // The property the guard rests on. A mutation that forgot to bump would make a stale completer look
    // current — which is the defect wearing a different hat.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const seen: number[] = [];
    const revision = () => cleanup.snapshot()[0]?.revision ?? -1;

    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [ref] });
    seen.push(revision());
    await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [{ key: "b.json", digest: "d" }] });
    seen.push(revision());
    await cleanup.confirm({ tenant: "acme", executionId: EXECUTION, keys: [KEY] });
    seen.push(revision());
    await cleanup.releaseForGc("acme", EXECUTION);
    seen.push(revision());
    await cleanup.deferred(`gc-${EXECUTION}`, "nope", new Date().toISOString());
    seen.push(revision());

    expect(seen, "a mutation left the revision where it was").toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size, "two different mutations shared one revision").toBe(seen.length);
  });
});
