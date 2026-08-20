import type { DriverAuthority, ResumeResult } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import { type RecoveryTarget, retryDeferredRecovery } from "./startup-recovery.js";

// ── A FENCING TOKEN IS ISSUED, NOT LOOKED UP (arch-review 57 P0) ─────────────────────────────────────
//
// arch-review 56 gave a deferred recovery a worklist, which closed "the comment says the next sweep asks
// again and there is no sweep". The worklist carries `{ kind, id }` — the target's IDENTITY — and the retry
// rebuilds the authority when it fires:
//
//   const authority = { ownerReplica: deps.owner, epoch: record.ownerEpoch };
//
// That is this process's replica id combined with WHOEVER'S epoch the row currently holds. So the retry does
// not re-present the capability its claim was granted; it manufactures a new one out of the successor's.
//
//   replica A   claim sc-1 → epoch 41 · resume → retry_later · worklist = { sc-1 }
//   replica B   A looks dead → takeover → epoch 42 · starts driving the batch
//   replica A   retry fires → reads the row → epoch 42 → drives as { A, 42 }
//
// and the write fence checks `expectOwnerEpoch` alone, so 42 is accepted. A displaced replica acts with its
// successor's authority, which is the one thing a fencing token exists to prevent. The generation is not a
// version number to be read; it is a capability a claim transition handed to a specific owner.
//
// RED as of e488e061, observed:
//   expected the displaced retry to be discharged, but resume() was called with { ownerReplica: 'replica-a',
//   epoch: 42 } — the successor's generation
//
// The existing counterexample beside this one drives the same retry, but only ever with one replica holding
// one epoch, so it is green either way: it pins that the worklist RETRIES, not what it retries AS.

type Row = Record<string, unknown>;

function world(row: Row) {
  const seen: DriverAuthority[] = [];
  const deps = {
    scorecards: {
      async get() {
        return row;
      },
    } as never,
    owner: "replica-a",
    async resume(_id: string, authority: DriverAuthority): Promise<ResumeResult> {
      seen.push(authority);
      return { kind: "resumed" };
    },
  };
  return { deps, seen };
}

const owed: RecoveryTarget[] = [
  // What replica A was granted when it claimed the batch: generation 41, to A. The worklist has to carry it,
  // because the row will not — the row holds whoever owns it NOW.
  { kind: "scorecard", id: "sc-1", authority: { ownerReplica: "replica-a", epoch: 41 }, attempts: 1 },
];

describe("[R57 COUNTEREXAMPLE] a deferred retry re-presents its own claim, and never adopts a successor's", () => {
  it("does not drive a record whose ownership moved on — the target is discharged as displaced", async () => {
    // Replica B took over while A's retry was pending: a new generation, and a new owner.
    const { deps, seen } = world({ id: "sc-1", status: "running", ownerReplica: "replica-b", ownerEpoch: 42 });

    const stillOwed = await retryDeferredRecovery(deps, owed);

    expect(
      seen,
      `the displaced retry drove the batch anyway, as ${JSON.stringify(seen[0])} — the successor's generation`,
    ).toEqual([]);
    // …and it is not owed either. Nothing is unfinished here: replica B owns this batch and is driving it.
    // Keeping it on A's worklist would have A retrying forever against work that is not its own.
    expect(
      stillOwed,
      "a displaced target stayed owed, so this replica will keep asking about someone else's work",
    ).toEqual([]);
  });

  it("still drives a record it genuinely owns — the check is a fence, not a ban on retrying", async () => {
    const { deps, seen } = world({ id: "sc-1", status: "running", ownerReplica: "replica-a", ownerEpoch: 41 });
    await retryDeferredRecovery(deps, owed);
    expect(seen).toEqual([{ ownerReplica: "replica-a", epoch: 41 }]);
  });

  it("refuses a row whose generation moved even when the OWNER name is unchanged", async () => {
    // A replica that restarted under the same name is a different holder of the batch, and the GENERATION is
    // what says so — the store issues `ownerEpoch + 1` per record, so a takeover moves it whoever performs
    // one. This is the case that would slip past a name-only check.
    const { deps, seen } = world({ id: "sc-1", status: "running", ownerReplica: "replica-a", ownerEpoch: 42 });
    await retryDeferredRecovery(deps, owed);
    expect(seen, "a restarted replica reused a generation it no longer holds").toEqual([]);
  });
});
