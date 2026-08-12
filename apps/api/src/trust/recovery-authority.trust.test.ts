import type { RunRecord, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-142.
//
// A CAS GUARD PRESENT IS NOT A CAS AUTHORITY CONSUMED.
//
// Every terminal writer carries its fence now, and the fences work: a losing write matches no row and no
// durable event is inserted. What the fences never said is who may act NEXT. A recovery whose claim lost
// still dispatched, a cancel whose settle lost still cascaded to the children, and a resume whose adoption
// lost still seeded the harvested result into the aggregate — the rows stayed honest and the WORK did not.
//
// The rule these scenarios pin: authority to do anything downstream comes from the transition that
// COMMITTED, never from the code path that attempted one.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const run = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: "run-1",
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c-1",
    status: "running",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...over,
  }) as RunRecord;

const batch = (over: Partial<ScorecardRecord> = {}): ScorecardRecord =>
  ({
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status: "running",
    ownerReplica: "cp-dead",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...over,
  }) as unknown as ScorecardRecord;

describeTrust("TRUST-142 — only the writer that won the CAS may act on it", () => {
  it("an ownership claim is EXCLUSIVE — two replicas cannot both take one run", async () => {
    const store = new InMemoryRunStore();
    await store.create(run({ ownerReplica: "cp-dead" }));
    // Both replicas read the same dead owner and both try to take the work.
    const first = await store.update("run-1", { ownerReplica: "cp-a" }, undefined, {
      expectNonTerminal: true,
      expectOwnerReplica: "cp-dead",
    });
    const second = await store.update("run-1", { ownerReplica: "cp-b" }, undefined, {
      expectNonTerminal: true,
      expectOwnerReplica: "cp-dead",
    });
    // Exactly one. `expectNonTerminal` alone answered "the run is open", which is true for BOTH — it was
    // never an answer to "may I take it", and the loser went on to re-dispatch the same case.
    expect([first, second].filter((r) => r !== undefined)).toHaveLength(1);
    expect((await store.get("run-1"))?.ownerReplica).toBe("cp-a");
  });

  it("a claim on a run that settled since the read wins nothing", async () => {
    const store = new InMemoryRunStore();
    await store.create(run({ ownerReplica: "cp-dead", status: "succeeded" }));
    const claimed = await store.update("run-1", { ownerReplica: "cp-a" }, undefined, {
      expectNonTerminal: true,
      expectOwnerReplica: "cp-dead",
    });
    expect(claimed).toBeUndefined();
  });

  // arch-review 29 P0: EXCLUSIVE RECOVERY CLAIM IS NOT A TERMINAL-STATE CLAIM. The owner condition asks "is
  // the dead replica still the owner", and that stays TRUE after the work finished — so a batch that
  // succeeded while a recovery was deciding got claimed, failed to resume (it is already done), and was
  // tombstoned FAILED{INTERRUPTED}. A successful evaluation recorded in history as an infrastructure failure
  // is the most direct way this platform can lie about a result.
  it("a settled batch refuses BOTH the recovery claim and the tombstone that follows it", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(batch({ status: "succeeded" }));
    const claimed = await store.update("sc-1", { ownerReplica: "cp-a" }, undefined, {
      expectOwnerReplica: "cp-dead",
      expectNonTerminal: true,
    });
    expect(claimed).toBeUndefined();
    // …and the fallback the recovery would have written next is refused on its own terms, so the fence holds
    // even if a caller forgets the claim.
    const tombstoned = await store.update(
      "sc-1",
      { status: "failed", error: { code: "INTERRUPTED", message: "boot" } } as never,
      undefined,
      { expectNonTerminal: true },
    );
    expect(tombstoned).toBeUndefined();
    expect((await store.get("sc-1"))?.status).toBe("succeeded");
  });

  it("a scorecard recovery claim is exclusive too — the batch has one owner, not two drivers", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(batch());
    const first = await store.update("sc-1", { ownerReplica: "cp-a" }, undefined, {
      expectOwnerReplica: "cp-dead",
    });
    const second = await store.update("sc-1", { ownerReplica: "cp-b" }, undefined, {
      expectOwnerReplica: "cp-dead",
    });
    expect([first, second].filter((r) => r !== undefined)).toHaveLength(1);
    // …and the loser is not this batch's recovery: resuming it would drive the same unfinished cases twice,
    // which the child terminal CAS cannot prevent because both dispatches are legitimate new work.
    expect((await store.get("sc-1"))?.ownerReplica).toBe("cp-a");
  });
});

// …and the other half of the same rule: a resume that LOST the adoption must not build the aggregate from
// the result it harvested. The two are usually equal and nothing proves it — collection, scoring and trace
// completion all happen on their own clocks — so the ledger row is what a reader sees a year later, and the
// ledger row is what the aggregate must be built from.
describeTrust("TRUST-142 — a rejected transition is not rejected evidence", () => {
  it("a lost adoption seeds the PERSISTED result, not the harvested one", async () => {
    const store = new InMemoryRunStore();
    await store.create(run({ id: "child-1", status: "running" }));
    // The real worker settles first, with its own result.
    await store.update(
      "child-1",
      {
        status: "succeeded",
        result: { caseId: "c-1", harness: "h@1", trace: [], scores: [], snapshot: { kind: "prompt", output: "B" } },
      } as never,
      undefined,
      { expectNonTerminal: true },
    );
    // …and the recovery's adoption arrives late, carrying a different harvest.
    const claimed = await store.update(
      "child-1",
      {
        status: "succeeded",
        result: { caseId: "c-1", harness: "h@1", trace: [], scores: [], snapshot: { kind: "prompt", output: "A" } },
      } as never,
      undefined,
      { expectNonTerminal: true },
    );
    expect(claimed).toBeUndefined();
    // What the resume must seed is what the LEDGER holds — the row a reader opens, not the value the losing
    // path happened to be holding when it lost.
    const persisted = await store.get("child-1");
    expect((persisted?.result?.snapshot as { output?: string } | undefined)?.output).toBe("B");
  });
});

// …and the last shape of the same rule: OWNER IDENTITY CHANGED IS NOT STALE DRIVER FENCED.
//
// A replica that paused past the liveness threshold — a long GC, a partition — is declared dead and its
// batch is claimed. Then it comes back with its in-memory execution loop intact. The database saying somebody
// else owns the batch does not reach that process: it is not asking. Identity answers "who should be
// driving"; the paused driver never posed the question.
//
// The epoch is what makes a takeover observable to the loser. It rises in the same statement as the claim
// that wins it, the winner carries the value, and every write that DRIVES the batch proves it — so the stale
// driver's next write fails against a number that moved under it, which is the only signal a process that
// never noticed it was gone reliably gets.
describeTrust("TRUST-142 — a takeover fences the driver it replaced", () => {
  it("the stale driver's settle is refused against an epoch that moved", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(batch({ ownerReplica: "cp-a", ownerEpoch: 4 } as never));
    // The paused driver began its loop under epoch 4 and still holds it.
    const staleEpoch = 4;

    // A recovery declares cp-a dead and claims the batch; the claim raises the token.
    const claimed = await store.update("sc-1", { ownerReplica: "cp-b" }, undefined, {
      expectOwnerReplica: "cp-a",
      expectNonTerminal: true,
      claimOwnership: true,
    });
    expect(claimed?.ownerEpoch).toBe(5);

    // …and cp-a comes back and tries to settle the batch it thinks it owns.
    const stale = await store.update("sc-1", { status: "succeeded" } as never, undefined, {
      expectNonTerminal: true,
      expectOwnerEpoch: staleEpoch,
    });
    expect(stale).toBeUndefined();
    expect((await store.get("sc-1"))?.status).toBe("running");

    // The new owner, driving under the epoch it won, settles normally.
    const settled = await store.update("sc-1", { status: "succeeded" } as never, undefined, {
      expectNonTerminal: true,
      expectOwnerEpoch: claimed?.ownerEpoch,
    });
    expect(settled).toBeDefined();
  });

  it("a batch nobody has claimed drives without a token — the fence is for takeovers, not for solitude", async () => {
    // A single-replica install claims nothing, so demanding a token there would leave a batch nobody may
    // settle. The absent epoch behaves exactly as before.
    const store = new InMemoryScorecardStore();
    await store.create(batch({ ownerReplica: undefined } as never));
    const settled = await store.update("sc-1", { status: "succeeded" } as never, undefined, {
      expectNonTerminal: true,
    });
    expect(settled).toBeDefined();
  });
});

// …and the seam, not only the primitive (arch-review 30 P1). TRUST-142's store scenarios prove that a stale
// write is refused; the defect they could not see was one layer up — the loop IGNORED the refusal and went
// on creating children and dispatching cases. `primitive certified ≠ seam certified` cost a review once
// already (the batch heartbeat), so the driver's own authority check gets a scenario of its own.
describeTrust("TRUST-142 — a fenced driver stops dispatching, not just writing", () => {
  it("the authority proof fails after a takeover, and it is what the loop consults", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(batch({ ownerReplica: "cp-a", ownerEpoch: 4 } as never));

    // The proof the loop performs before each case: a guarded touch under the epoch it began with.
    const prove = (epoch: number) =>
      store.update("sc-1", { updatedAt: "2026-08-12T00:00:01.000Z" }, undefined, {
        expectOwnerEpoch: epoch,
        expectNonTerminal: true,
      });

    // Before the takeover it holds, so an ordinary batch dispatches normally.
    expect(await prove(4)).toBeDefined();

    // A recovery takes over: the claim raises the token in the same statement.
    const claimed = await store.update("sc-1", { ownerReplica: "cp-b" }, undefined, {
      expectOwnerReplica: "cp-a",
      expectNonTerminal: true,
      claimOwnership: true,
    });
    expect(claimed?.ownerEpoch).toBe(5);

    // …and the paused driver's next proof fails — which is what stops the fan-out, one case in, instead of
    // letting it run the whole batch on compute it no longer owns.
    expect(await prove(4)).toBeUndefined();
    expect(await prove(5)).toBeDefined();
  });
});
