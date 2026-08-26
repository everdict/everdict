import type { ArtifactProbe, ArtifactRef, IntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import { evaluateRef } from "../ports/intermediate-cleanup-store.js";

// ── THE DEBT IS PAID BY SOMEBODY WHO OUTLIVES THE PROCESS THAT INCURRED IT (arch-review 68) ─────────
//
// The settlement discharges inline, which covers every case that settles in the process that ran it. What it
// cannot cover is the reason the ledger exists at all: a control plane that dies between the staging and the
// settlement, or a delete that did not converge. Both leave a row saying "these bytes are garbage" and
// nobody looking at it.
//
// This is the looking. It is deliberately small and deliberately NOT the correctness owner of anything the
// settlement does — the settlement releases, this collects, and the difference is what keeps an inline
// optimization from being load-bearing (rule `protocol`: an inline cleanup after a commit is not a
// lifecycle).
//
// ⚠️ IT COLLECTS ONLY WHAT WAS RELEASED. `due()` returns `gc_owed`/`retry_wait` and never `retained`, and
// that is the whole safety property: a sweep that could see retained rows would delete the artifact a
// crashed case is about to be recovered from — turning the ledger into a way of destroying the recovery it
// was built to enable.
export interface IntermediateCleanupReconcilerDeps {
  cleanup: IntermediateCleanupStore;
  // Remove one staged object. Routed by key prefix at the composition root, exactly as the settlement's
  // discharge routes it, so both spend the same function.
  remove: (key: string) => Promise<void>;
  // How to ask whether a ref's bytes exist — see `evaluateRef`. Absent = this deployment cannot ask, and an
  // unconfirmed ref then holds the debt open exactly as it did before (arch-review 70 P1).
  probe?: ArtifactProbe;
  now?: () => string;
  // How many debts one tick drains. Small on purpose: this competes with live dispatch for the object
  // store, and a debt that waits one more minute costs storage rather than correctness.
  batch?: number;
  // How long an unconverged delete waits. Not exponential: the failure this actually sees is an object store
  // that is briefly unreachable, and an operator reading `attempts` wants a number that means minutes.
  backoffMs?: number;
}

export interface CleanupTick {
  claimed: number;
  completed: number;
  deferred: number;
}

export class IntermediateCleanupReconciler {
  constructor(private readonly deps: IntermediateCleanupReconcilerDeps) {}

  async tick(): Promise<CleanupTick> {
    const now = this.deps.now ?? (() => new Date().toISOString());
    const due = await this.deps.cleanup.due(now(), this.deps.batch ?? 50);
    let completed = 0;
    let deferred = 0;

    for (const debt of due) {
      const failures: string[] = [];
      for (const ref of debt.refs) {
        // ⚠️ A REF WHOSE WRITE NEVER LANDED IS NOT DELETED AND NOT COUNTED DONE. `owe` records the debt
        // BEFORE the put so a crash between them leaves something to find; the consequence is that a ref can
        // name bytes that do not exist. Deleting an absent key "succeeds" on every object store, so counting
        // it would let this sweep complete a debt whose put is still in flight behind it — orphaning exactly
        // the object the row was written to protect.
        //
        // Unconfirmed refs therefore hold the debt open. The staging confirms within milliseconds of the
        // put; a ref still unconfirmed when a sweep arrives is a write that died, and the next tick asks
        // again rather than this one guessing.
        // ── …AND AN UNCONFIRMED REF CONVERGES RATHER THAN DEFERRING FOREVER (arch-review 70 P1) ─────
        //
        // The refusal above was right and it was not a lifecycle: if the writer died and the write genuinely
        // failed, `written` never becomes true and this row retries until a human looks at it. So the ref is
        // now RESOLVED against the object store — the only thing that can tell "still in flight" from "never
        // landed" — through the same evaluator the inline discharge spends.
        const state = await evaluateRef(ref, this.deps.probe);
        if (state === "unknown") {
          failures.push(`${ref.key}: never confirmed written, and the store would not say whether it exists`);
          continue;
        }
        // ABANDONED: the write is not coming, so there is nothing to delete and nothing left owed for it.
        if (state === "abandoned") continue;
        try {
          await this.deps.remove(ref.key);
        } catch (err) {
          failures.push(`${ref.key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (failures.length > 0) {
        await this.deps.cleanup
          .deferred(
            debt.operationId,
            failures.join("; "),
            new Date(Date.parse(now()) + (this.deps.backoffMs ?? 60_000)).toISOString(),
          )
          .catch(() => undefined);
        deferred += 1;
        continue;
      }
      // Completed only when EVERY ref converged. A partially-drained debt stays owed, because the row is the
      // worklist and a worklist that forgets half its items is not one (rule `protocol` L5).
      if (await this.deps.cleanup.complete(debt.tenant, debt.executionId)) completed += 1;
    }

    return { claimed: due.length, completed, deferred };
  }
}

// The composition root's key router, shared by the settlement's discharge and this sweep so an object is
// deleted from the same bucket by both.
// …and how to ASK. Same prefix routing as the remover, because a ref is answered by the store that would
// have written it — and a store fault is `unknown`, never "absent" (rule `protocol` L2).
export function cleanupProbe(stores: {
  agentHalves?: { get(key: string): Promise<Uint8Array | undefined> };
  verdicts?: { get(key: string): Promise<Uint8Array | undefined> };
}): ArtifactProbe {
  return async (key: string) => {
    const store = key.startsWith("verifier-verdict/") ? stores.verdicts : stores.agentHalves;
    if (!store) return "unknown"; // nothing here can answer for this prefix, and silence is not absence
    try {
      return (await store.get(key)) !== undefined ? "present" : "absent";
    } catch {
      return "unknown";
    }
  };
}

export function cleanupRemover(stores: {
  agentHalves?: { remove(key: string): Promise<void> };
  verdicts?: { remove(key: string): Promise<void> };
}): (key: string) => Promise<void> {
  return async (key: string) => {
    const store = key.startsWith("verifier-verdict/") ? stores.verdicts : stores.agentHalves;
    if (!store) return;
    await store.remove(key);
  };
}

export type { ArtifactRef };
