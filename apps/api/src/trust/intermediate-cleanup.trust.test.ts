import { IntermediateCleanupReconciler, cleanupRemover, dischargeIntermediates } from "@everdict/application-control";
import type { ExecutionId } from "@everdict/contracts";
import { PgIntermediateCleanupStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-180.
//
// THE CLEANUP DEBT SURVIVES THE PROCESS THAT INCURRED IT (arch-review 68).
//
// The ledger shipped in-memory, which closed the ordinary path — a case settling in one process discharges
// exactly what it staged, on every ending — and left the reason the ledger exists at all: a control plane
// that dies between the staging and the settlement leaks its artifacts forever, because the only record of
// what was owed died with it.
//
// This drives the REAL Postgres adapter over TWO independent store instances, which is how a restart looks
// from the row's point of view: the one that staged is gone, and the one that sweeps is reading something it
// did not write.
//
// ⚠️ THE SAFETY PROPERTY IS THE ONE THAT MATTERS MOST. `due()` must never return a RETAINED row — a sweep
// that could see one would delete the artifact a crashed case is about to be recovered from, turning the
// ledger into a way of destroying the recovery it was built to enable. The first version of this ledger
// wrote every debt as `owed` (the state meaning DELETE THIS) from the moment the bytes were staged, and
// nothing removed them only because no reconciler existed yet.
//
// Seen RED before the Postgres adapter existed, observed:
//   the debt did not survive the process that incurred it: expected [] to have a length of 1
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-180 — the intermediate cleanup debt outlives the process that incurred it", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => {
    await pg?.close();
  });

  // A staged artifact, in the two steps production takes: the debt is recorded BEFORE the put and confirmed
  // after it, so a crash between them leaves a row pointing at bytes that may not exist.
  const staged = async (executionId: ExecutionId, keys: string[], opts?: { confirm?: boolean }) => {
    const store = new PgIntermediateCleanupStore(pg.client);
    for (const key of keys) {
      await store.owe({ tenant: "acme", executionId, refs: [{ key, digest: `sha256:${key}` }] });
      if (opts?.confirm !== false) await store.confirm({ tenant: "acme", executionId, keys: [key] });
    }
    return store;
  };

  const objectStore = (keys: string[]) => ({
    keys,
    async remove(key: string) {
      const i = keys.indexOf(key);
      if (i >= 0) keys.splice(i, 1);
    },
  });

  it("a SECOND process finds the released debt and collects it", async () => {
    const executionId = `evd-${trustId("run")}` as ExecutionId;
    const half = `agent-half/acme/${executionId}/sha256:half.json`;
    const verdict = `verifier-verdict/acme/${executionId}/sha256:half/a#g2.json`;

    // Process one: stages both intermediates and settles.
    const staging = await staged(executionId, [half, verdict]);
    await staging.releaseForGc("acme", executionId);

    // Process one is gone. Everything below reads a row it did not write, through its own store instance.
    const sweeping = new PgIntermediateCleanupStore(pg.client);
    const objects = objectStore([half, verdict]);
    const tick = await new IntermediateCleanupReconciler({
      cleanup: sweeping,
      remove: cleanupRemover({ agentHalves: objects, verdicts: objects }),
      batch: 200,
    }).tick();

    expect(tick.completed, "the debt did not survive the process that incurred it").toBeGreaterThanOrEqual(1);
    expect(objects.keys, "the sweep left the released artifacts in storage").toEqual([]);
  });

  it("NEVER returns a retained debt to a sweep", async () => {
    // The safety property, against the real adapter's own SQL: `due()`'s predicate is what stands between a
    // reconciler and the artifact a crashed case still needs.
    const executionId = `evd-${trustId("run")}` as ExecutionId;
    const half = `agent-half/acme/${executionId}/sha256:half.json`;
    await staged(executionId, [half]);

    const due = await new PgIntermediateCleanupStore(pg.client).due(
      new Date(Date.now() + 86_400_000).toISOString(),
      500,
    );
    expect(
      due.map((d) => d.executionId),
      "a sweep was handed an artifact whose case has not settled",
    ).not.toContain(executionId);
  });

  it("ACCUMULATES both halves onto one row, and deduplicates a re-stage", async () => {
    // The two halves are staged at different moments and the second call must not forget the first — this is
    // a jsonb merge in SQL rather than a read-modify-write, because two writers race here in production.
    const executionId = `evd-${trustId("run")}` as ExecutionId;
    const half = `agent-half/acme/${executionId}/a.json`;
    const verdict = `verifier-verdict/acme/${executionId}/b.json`;
    const store = await staged(executionId, [half, verdict]);
    // A retry re-stages the same object: it is owed once, not twice.
    await store.owe({ tenant: "acme", executionId, refs: [{ key: half, digest: "sha256:again" }] });

    const released = await store.releaseForGc("acme", executionId);
    expect(released?.refs.map((r) => r.key).sort(), "the row forgot a half or double-counted a re-stage").toEqual(
      [half, verdict].sort(),
    );
  });

  it("HOLDS a debt whose write was never confirmed, rather than counting a missing key deleted", async () => {
    // `owe` records the debt BEFORE the put — deliberately, so a crash between them leaves something to find
    // — which means a ref can name bytes that do not exist. Deleting an absent key "succeeds" on every
    // object store, so counting it done would complete a debt whose put is still in flight behind it.
    const executionId = `evd-${trustId("run")}` as ExecutionId;
    const half = `agent-half/acme/${executionId}/never-written.json`;
    const store = await staged(executionId, [half], { confirm: false });
    await store.releaseForGc("acme", executionId);

    const tick = await new IntermediateCleanupReconciler({
      cleanup: store,
      remove: cleanupRemover({ agentHalves: objectStore([]) }),
      batch: 200,
      now: () => "2026-08-25T00:00:00.000Z",
    }).tick();

    expect(tick.deferred, "a debt whose write never landed was marked collected").toBeGreaterThanOrEqual(1);
    const held = (await store.due("2026-08-25T01:00:00.000Z", 500)).find((d) => d.executionId === executionId);
    expect(held?.state, "the unconfirmed debt was terminalized instead of held").toBe("retry_wait");
    expect(held?.lastError).toContain("never confirmed");
  });

  it("records the BACKOFF when an inline discharge fails — against the identity the row actually has", async () => {
    // ── THE CALLER WAS SPELLING THE ROW'S NAME ITSELF (arch-review 69 P2) ────────────────────────────
    //
    // `dischargeIntermediates` deferred against `gc-${executionId}` while this adapter mints
    // `gc/${tenant}/${executionId}`. So on real Postgres the UPDATE matched no row: the debt stayed
    // `gc_owed`, attempts/lastError/nextAttemptAt never moved, no backoff applied, and the reconciler
    // re-attempted the same failing delete every tick with nothing recording why. The in-memory twin spelled
    // it the same way the caller did, which is why every unit test agreed with the bug.
    //
    // This drives the REAL adapter through the real discharge with a remove that throws.
    //
    // Seen RED before `releaseForGc` returned the row's own operationId, observed:
    //   the failed discharge did not move the debt off gc_owed: expected 'gc_owed' to be 'retry_wait'
    const executionId = `evd-${trustId("run")}` as ExecutionId;
    const half = `agent-half/acme/${executionId}/unremovable.json`;
    const store = await staged(executionId, [half]);

    const outcome = await dischargeIntermediates(
      {
        cleanup: store,
        remove: async () => {
          throw new Error("the object store refused the delete");
        },
      },
      "acme",
      executionId,
    );
    expect(outcome.owed, "the discharge reported nothing owed after a failed delete").toBe(1);

    const held = (await store.due(new Date(Date.now() + 86_400_000).toISOString(), 500)).find(
      (d) => d.executionId === executionId,
    );
    expect(held?.state, "the failed discharge did not move the debt off gc_owed").toBe("retry_wait");
    expect(held?.attempts, "the attempt an operator reads was never counted").toBe(1);
    expect(held?.lastError, "nothing recorded WHY the delete did not converge").toContain("refused the delete");
    expect(held?.nextAttemptAt, "no backoff was applied, so the reconciler retries every tick").toBeDefined();
  });

  it("REFUSES to complete a debt no settlement released", async () => {
    // The guard that keeps a stray caller from marking an artifact collected while the case that needs it is
    // still running. A boolean, because the caller's response differs: `false` here is "there was nothing to
    // complete", not "the store refused to answer".
    const executionId = `evd-${trustId("run")}` as ExecutionId;
    const store = await staged(executionId, [`agent-half/acme/${executionId}/x.json`]);

    // The revision is the one the row ACTUALLY has, read straight from the table, so this refuses for the
    // right reason — the debt is still `retained` — rather than because the generation happened to disagree
    // (arch-review 72 P1-high). `staleRetained` is age-filtered and would not return a row made a moment ago.
    const { rows } = await pg.client.query<{ revision: number }>(
      "SELECT revision FROM everdict_intermediate_cleanup WHERE tenant = 'acme' AND execution_id = $1",
      [executionId],
    );
    expect(rows[0], "the fixture staged nothing, so this measures nothing").toBeDefined();
    expect(
      await store.complete("acme", executionId, Number(rows[0]?.revision)),
      "a retained debt was completed without any settlement releasing it",
    ).toBe("changed");
  });
});
