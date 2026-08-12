import { PgRunStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-145.
//
// OWNER IDENTITY ELECTS THE NEW DRIVER; THE FENCING TOKEN REVOKES THE OLD ONE.
//
// The batch learned this in mig 0166 and the RUN it is made of had not, which left the same hole one level
// down. Boot recovery claims an orphaned run under `expectOwnerReplica` — an exclusive ELECTION, so exactly
// one replica takes it. That is an answer to "who may drive this now" and no answer at all to the replica
// that was never actually dead: a long GC pause or a partition puts A past the liveness threshold, B claims
// the run and re-dispatches, and A comes back with its in-memory dispatch loop intact. Both then hold writes
// whose entire proof is "the row is still open", which is true for both, so whichever result lands first
// becomes the run's history.
//
// The epoch is the number a paused process cannot argue with. What is certified here is the whole sequence
// against real Postgres: A holds the epoch it dispatched under, B's claim raises it, and A's settle is
// REFUSED while B's is accepted — the displaced driver discovers the takeover the only way it can, by
// failing against a value that moved under it.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-145 — a displaced run driver cannot settle the run it lost", () => {
  let pg: TrustPg;
  let store: PgRunStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    store = new PgRunStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const seedRunning = async (id: string, owner: string): Promise<void> => {
    await pg.client.query(
      `INSERT INTO everdict_runs (id, tenant, harness_id, harness_version, case_id, status, owner_replica, created_at, updated_at)
       VALUES ($1,'trust','h','1.0.0',$2,'running',$3, now(), now())`,
      [id, `${id}-case`, owner],
    );
  };

  it("the epoch A dispatched under stops A's settle after B claims the run", async () => {
    const id = trustId("run-fence");
    await seedRunning(id, "replica-A");
    // A is driving under the epoch it read when it dispatched. A fresh row has never been claimed, so that
    // number is 0 — the honest predecessor of the value its first claimant will write.
    const epochA = (await store.get(id))?.ownerEpoch ?? 0;
    expect(epochA).toBe(0);

    // B's boot recovery declares A dead and claims the run: identity transfers AND the token rises, in one
    // statement. Both halves matter — the claim without the raise is the election that says nothing to A.
    const claimed = await store.update(
      id,
      { ownerReplica: "replica-B", updatedAt: new Date().toISOString() },
      undefined,
      { expectNonTerminal: true, expectOwnerReplica: "replica-A", claimOwnership: true },
    );
    expect(claimed?.ownerReplica).toBe("replica-B");
    expect(claimed?.ownerEpoch).toBe(1);

    // A wakes up. Its case finished; it settles the run it believes it still owns. The row IS still open, so
    // the terminal fence alone would let this through — which is precisely how the run's history used to be
    // decided by whichever process happened to write first.
    const staleSettle = await store.update(
      id,
      { status: "succeeded", updatedAt: new Date().toISOString() },
      undefined,
      { expectNonTerminal: true, expectOwnerEpoch: epochA },
    );
    expect(staleSettle).toBeUndefined();
    expect((await store.get(id))?.status).toBe("running");

    // …and B, holding the epoch it won, settles normally. The fence revokes a driver; it does not stop one.
    const settled = await store.update(
      id,
      { status: "failed", error: { code: "E", message: "b settled it" }, updatedAt: new Date().toISOString() },
      undefined,
      { expectNonTerminal: true, expectOwnerEpoch: claimed?.ownerEpoch ?? 0 },
    );
    expect(settled?.status).toBe("failed");
  });

  it("a run nobody ever claimed settles exactly as before — the fence is not a new requirement", async () => {
    // The token must never turn a single-replica install into a run nobody may settle. A driver that holds
    // no epoch passes none, and the write is fenced by the terminal condition alone, as it always was.
    const id = trustId("run-unclaimed");
    await seedRunning(id, "replica-solo");
    const settled = await store.update(id, { status: "succeeded", updatedAt: new Date().toISOString() }, undefined, {
      expectNonTerminal: true,
    });
    expect(settled?.status).toBe("succeeded");
  });
});
