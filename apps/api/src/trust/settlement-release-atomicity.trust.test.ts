import type { AttemptStamp, CleanupRelease, ReleasedCleanup } from "@everdict/application-control";
import type { ExecutionId } from "@everdict/contracts";
import { PgIntermediateCleanupStore, PgRunStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-182.
//
// CANONICAL TRUTH AND CLEANUP ELIGIBILITY ARE BORN TOGETHER (arch-review 70 P1).
//
// The cleanup ledger became durable in arch-review 68 and its RELEASE stayed a second commit: the settlement
// transaction committed, and `releaseForGc` ran afterwards as an ordinary call. A crash in that gap leaves
// the row `retained` — and `due()` returns only `gc_owed | retry_wait`, deliberately, because a retained
// artifact is one a recovery may still need. So the intermediates of an execution that is ALREADY TERMINAL
// are kept forever, by a reconciler that is working exactly as designed.
//
// Not a failed delete. A row that never became eligible to be deleted.
//
// ⚠️ ONLY REAL POSTGRES CAN CERTIFY THIS. The property is that one transaction carries both writes, so the
// in-memory twin — which has no transaction and settles in two steps by construction — cannot tell the fixed
// code from the broken code. Same reason arch-review 66's parent-authority join needed a real adapter.
//
// What is certified here, against the real `PgRunStore.settleWith`:
//   the debt is `gc_owed` the moment the settlement returns, with NO second call
//   a REFUSED fence rolls the release back with the terminal write it was riding
//
// Seen RED before the release rode the transaction, observed:
//   the settlement committed and left its intermediates unreleasable: expected 'retained' to be 'gc_owed'
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-182 — a settlement frees its intermediates in the same transaction", () => {
  let pg: TrustPg;
  let runs: PgRunStore;
  let cleanup: PgIntermediateCleanupStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    runs = new PgRunStore(pg.client);
    cleanup = new PgIntermediateCleanupStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const seedRunning = async (id: string): Promise<void> => {
    await pg.client.query(
      `INSERT INTO everdict_runs (id, tenant, harness_id, harness_version, case_id, status, created_at, updated_at)
       VALUES ($1,'trust','h','1.0.0',$2,'running', now(), now())`,
      [id, `${id}-case`],
    );
  };

  // A debt in the state a live private-verifier case leaves behind: bytes staged, confirmed, retained.
  const owed = async (executionId: ExecutionId, key: string): Promise<void> => {
    await cleanup.owe({ tenant: "trust", executionId, refs: [{ key, digest: `sha256:${key}` }] });
    await cleanup.confirm({ tenant: "trust", executionId, keys: [key] });
  };

  // The attempt stamp the standalone lane always rides. Nothing here is about attempts — it is required to
  // reach `settleWith` at all, which is the transactional path.
  const stamp = (attemptId: string): AttemptStamp => ({
    attemptId,
    attempts: { transition: async () => true } as never,
    apply: async () => undefined,
  });

  const rider = (executionId: ExecutionId): { release: CleanupRelease; freed: () => ReleasedCleanup | undefined } => {
    let freed: ReleasedCleanup | undefined;
    return {
      freed: () => freed,
      release: {
        cleanup,
        apply: async (bound) => {
          freed = await bound.releaseForGc("trust", executionId);
        },
      },
    };
  };

  const stateOf = async (executionId: string): Promise<string | undefined> => {
    const { rows } = await pg.client.query<{ state: string }>(
      `SELECT state FROM everdict_intermediate_cleanup WHERE tenant = 'trust' AND execution_id = $1`,
      [executionId],
    );
    return rows[0]?.state;
  };

  it("leaves the debt COLLECTABLE the moment the settlement returns", async () => {
    const id = trustId("run-atomic");
    const executionId = `evd-run-${id}` as ExecutionId;
    await seedRunning(id);
    await owed(executionId, `agent-half/trust/${executionId}/a.json`);
    expect(await stateOf(executionId), "the debt did not start retained").toBe("retained");

    const r = rider(executionId);
    const settled = await runs.settleWith(
      id,
      { status: "succeeded", updatedAt: new Date().toISOString() },
      undefined,
      { expectNonTerminal: true },
      stamp(`${executionId}#agent`),
      r.release,
    );

    expect(settled?.status, "the settlement did not land").toBe("succeeded");
    // THE PROPERTY. No second call has been made — this is the state the transaction left behind, which is
    // what a process that died one instruction later would leave.
    expect(await stateOf(executionId), "the settlement committed and left its intermediates unreleasable").toBe(
      "gc_owed",
    );
    // …and what it freed came back out, so the objects can be deleted OUTSIDE the transaction.
    expect(r.freed()?.refs, "the release returned nothing for the caller to collect").toHaveLength(1);
  });

  it("ROLLS THE RELEASE BACK when the fence refuses the settlement", async () => {
    // The other half of "one decision": a settlement that did not happen frees nothing. Without the
    // transaction this is two independent writes and the loser's release would stand.
    const id = trustId("run-refused");
    const executionId = `evd-run-${id}` as ExecutionId;
    await seedRunning(id);
    await owed(executionId, `agent-half/trust/${executionId}/b.json`);
    // Terminalize it first, so the `expectNonTerminal` fence refuses the settle below.
    await pg.client.query(`UPDATE everdict_runs SET status = 'succeeded' WHERE id = $1`, [id]);

    const settled = await runs.settleWith(
      id,
      { status: "failed", updatedAt: new Date().toISOString() },
      undefined,
      { expectNonTerminal: true },
      stamp(`${executionId}#agent`),
      rider(executionId).release,
    );

    expect(settled, "the fence did not refuse").toBeUndefined();
    expect(await stateOf(executionId), "a refused settlement released artifacts the winner still needs").toBe(
      "retained",
    );
  });

  it("settles exactly as before when the deployment has no cleanup ledger", async () => {
    // The control. `release` is optional, and a lane without one must keep the settlement it has.
    const id = trustId("run-noledger");
    await seedRunning(id);
    const settled = await runs.settleWith(
      id,
      { status: "succeeded", updatedAt: new Date().toISOString() },
      undefined,
      { expectNonTerminal: true },
      stamp(`evd-run-${id}#agent`),
    );
    expect(settled?.status).toBe("succeeded");
  });
});
