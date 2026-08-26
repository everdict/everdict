import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryIntermediateCleanupStore, collectReleased } from "../ports/intermediate-cleanup-store.js";
import { IntermediateCleanupReconciler, cleanupProbe, cleanupRemover } from "./intermediate-cleanup-reconciler.js";

// ── ONE DEBT, TWO READINGS — AND A PLANNED WRITE THAT NEVER CONVERGED (arch-review 70 P1) ──────────
//
// `owe` precedes the put deliberately, so a ref can name bytes that do not exist. The reconciler respected
// that (`written !== true` → do not delete, defer). The INLINE discharge did not: it removed every released
// ref without looking. Deleting an absent key succeeds on every object store, so the settlement completed a
// debt whose put was still in flight — and when that put landed, the object had no owner:
//
//     owe(K) → put(K) requested → client times out, server still writing → stage reports failure
//     settlement → releaseForGc → remove(K) → "succeeded" (K is not there yet) → debt COMPLETED
//     put(K) lands → K exists, owned by nobody, named by no row
//
// The same ref meant "do not delete" to the sweep and "deleting it counts" to the settlement. That is L5's
// one-verifier law broken for artifacts, so both paths spend ONE evaluator now.
//
// And the half that remained even with the inline path fixed: an unconfirmed ref was deferred FOREVER. If the
// writer died and the write genuinely failed, `written` never becomes true and the row retries forever.
// "Still in flight" and "never landed" are different states, and only the object store can tell them apart —
// so an unconfirmed ref is now RESOLVED by an exact read: present → delete, absent → abandoned, unreadable →
// still owed (rule `protocol` L2 — "we could not find out" is never a terminal).
//
// Seen RED before the evaluator was shared, observed:
//   the inline discharge deleted a ref whose write never landed: expected [ 'agent-half/in-flight.json' ] to
//     deeply equal []
//   an unconfirmed ref was deferred forever instead of converging: expected 1 to be 0

const EXECUTION = storedExecutionId("evd-run-r1");
const KEY = "agent-half/in-flight.json";

// An object store that holds a known set of keys and records what was deleted.
function objects(present: string[]) {
  const keys = new Set(present);
  const removed: string[] = [];
  return {
    removed,
    keys,
    async get(key: string) {
      return keys.has(key) ? new Uint8Array([1]) : undefined;
    },
    async remove(key: string) {
      removed.push(key);
      keys.delete(key);
    },
  };
}

const owedUnconfirmed = async (cleanup: InMemoryIntermediateCleanupStore) => {
  await cleanup.owe({ tenant: "acme", executionId: EXECUTION, refs: [{ key: KEY, digest: "sha256:x" }] });
  // …and NO confirm: this is the state a put that never answered leaves behind.
  return await cleanup.releaseForGc("acme", EXECUTION);
};

describe("[R70 COUNTEREXAMPLE] the inline discharge reads a ref the way the sweep does", () => {
  it("does NOT delete a ref whose write never landed", async () => {
    const cleanup = new InMemoryIntermediateCleanupStore();
    const released = await owedUnconfirmed(cleanup);
    const store = objects([]); // the put never landed

    await collectReleased(
      { cleanup, remove: cleanupRemover({ agentHalves: store }), probe: cleanupProbe({ agentHalves: store }) },
      // biome-ignore lint/style/noNonNullAssertion: the release above always returns a row in this fixture
      released!,
      "acme",
      EXECUTION,
    );

    expect(store.removed, "the inline discharge deleted a ref whose write never landed").toEqual([]);
  });

  it("DOES delete a ref whose put landed but whose confirm did not", async () => {
    // The other side of the same read, and the reason the probe is worth making: the bytes are there and the
    // ledger simply never heard about them. Deferring forever would keep a real object alive forever.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const released = await owedUnconfirmed(cleanup);
    const store = objects([KEY]);

    await collectReleased(
      { cleanup, remove: cleanupRemover({ agentHalves: store }), probe: cleanupProbe({ agentHalves: store }) },
      // biome-ignore lint/style/noNonNullAssertion: the release above always returns a row in this fixture
      released!,
      "acme",
      EXECUTION,
    );

    expect(store.removed, "an object whose confirm was lost was kept forever").toEqual([KEY]);
  });
});

describe("[R70 COUNTEREXAMPLE] an unconfirmed ref converges instead of deferring forever", () => {
  const sweep = (cleanup: InMemoryIntermediateCleanupStore, store: ReturnType<typeof objects>, probe: boolean) =>
    new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: store }),
      ...(probe ? { probe: cleanupProbe({ agentHalves: store }) } : {}),
    }).tick();

  it("ABANDONS a ref the store says was never written, and closes the debt", async () => {
    const cleanup = new InMemoryIntermediateCleanupStore();
    await owedUnconfirmed(cleanup);
    const store = objects([]);

    const tick = await sweep(cleanup, store, true);

    expect(tick.deferred, "an unconfirmed ref was deferred forever instead of converging").toBe(0);
    expect(tick.completed, "the debt never closed, so it is retried until a human looks at it").toBe(1);
    expect(store.removed, "a delete was issued for bytes that do not exist").toEqual([]);
  });

  it("HOLDS the debt when the store would not say", async () => {
    // L2's third value. A store fault must not read as "the object is gone" — that is the reading that would
    // let a sweep certify a deletion it never made.
    const cleanup = new InMemoryIntermediateCleanupStore();
    await owedUnconfirmed(cleanup);
    const faulting = {
      async get(): Promise<Uint8Array | undefined> {
        throw new Error("the object store is unreachable");
      },
      async remove() {},
    };

    const tick = await new IntermediateCleanupReconciler({
      cleanup,
      remove: cleanupRemover({ agentHalves: faulting }),
      probe: cleanupProbe({ agentHalves: faulting }),
    }).tick();

    expect(tick.deferred, "an unreadable store was treated as an answer").toBe(1);
    expect(tick.completed).toBe(0);
  });

  it("keeps the OLD behaviour for a deployment that cannot ask", async () => {
    // The control: `probe` is optional, and without one an unconfirmed ref holds the debt open exactly as it
    // did before. This fix adds a way to converge; it does not make silence into a decision.
    const cleanup = new InMemoryIntermediateCleanupStore();
    await owedUnconfirmed(cleanup);
    const store = objects([]);

    const tick = await sweep(cleanup, store, false);

    expect(tick.deferred).toBe(1);
    expect(tick.completed).toBe(0);
  });
});
