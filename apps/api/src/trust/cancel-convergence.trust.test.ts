import { CancellationCoordinator, ScorecardService } from "@everdict/application-control";
import type { CaseJob } from "@everdict/contracts";
import { PgCancellationStore, PgCaseReceiptStore, PgRunStore, PgScorecardStore } from "@everdict/db";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-177.
//
// A CANCEL WHOSE TEARDOWN DIED STILL CONVERGES — AND THE THING THAT CONVERGES IT IS A ROW IN POSTGRES.
//
// The cancel protocol is terminal-first on purpose: commit the CANCELLED decision, then tear the live work
// down. The decision must survive a teardown that cannot run — but until arch-review 47 §5.2 the reverse was
// also true and nobody owned it. A 5xx converges because a caller retries; a control-plane crash between the
// commit and a failed teardown has no caller left, and the difference (children "running" for ever, leases
// held, cluster compute burning for a batch nobody will read) was visible to nothing. The recovery procedure
// was a human noticing and cancelling again.
//
// The operation ledger (mig 0184) gives that gap an owner, and its whole value is DURABILITY — which is
// precisely the property an in-memory twin cannot demonstrate. This drives the real `ScorecardService`
// against real `PgScorecardStore` / `PgRunStore` / `PgCancellationStore`, over a batch whose children were
// created by a real submit:
//
//   ① a teardown that throws leaves the batch CANCELLED, the operation row still owed with its reason
//     recorded, and the children untouched — the exact state a crashed control plane leaves behind;
//   ② `reconcileCancellations` — the sweep a second replica runs — re-runs the same idempotent steps, settles
//     the children in Postgres and completes the row;
//   ③ a second sweep finds nothing. A reconciler that keeps re-tearing-down completed operations would be a
//     background job cancelling work on every pass for ever.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-177 — a cancel whose teardown failed is owed, and a reconciler pays it", () => {
  let pg: TrustPg;
  let tenant: string;
  const scorecardIds: string[] = [];

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-cancel");
  });
  afterAll(async () => {
    if (scorecardIds.length > 0)
      await pg.client
        .query("DELETE FROM everdict_cancellation_operations WHERE scorecard_id = ANY($1)", [scorecardIds])
        .catch(() => undefined);
    if (tenant) {
      await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [tenant]).catch(() => undefined);
      await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]).catch(() => undefined);
      await pg.client.query("DELETE FROM everdict_platform_events WHERE tenant = $1", [tenant]).catch(() => undefined);
    }
    await pg?.close();
  });

  it("a failed teardown leaves the operation owed; the reconciler settles the children in Postgres and closes it", async () => {
    const store = new PgScorecardStore(pg.client);
    const runStore = new PgRunStore(pg.client);
    const cancellations = new PgCancellationStore(pg.client);
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register(tenant, {
      id: "cancel-set",
      version: "1.0.0",
      tags: [],
      cases: ["c1", "c2"].map((id) => ({
        id,
        env: { kind: "prompt" as const },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
    });

    // A dispatch that never comes back — the in-flight state a user actually cancels into. The children are
    // created by the real batch loop under the real parent fence, so what the teardown finds is production's
    // own row shape rather than one this file wrote.
    const inFlight = new Promise<never>(() => {});
    // The lease revocation is the AWAITED half of the teardown (arch-review 47 P0-1), so it is where a
    // teardown failure is expressed: a rejection here is the transient the reconciler exists for.
    let revocationFails = true;
    const revoked: number[] = [];
    // The sweep is the CancellationCoordinator's (arch-review 52, Wave 3): one reconciler over one ledger,
    // each owed row handed to the teardown that owns its kind. Built per pass, exactly as a booting replica
    // builds it — this scenario's whole point is that the owner need not be the process that decided.
    const sweep = (): CancellationCoordinator =>
      new CancellationCoordinator({
        cancellations,
        now: () => new Date().toISOString(),
        teardowns: { scorecard: service.cancellationTeardown() },
      });
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(_job: CaseJob) {
          return inFlight;
        },
      },
      store,
      runStore,
      // A case's canonical outcome is its commit receipt, so the batch refuses to run without the ledger.
      caseReceipts: new PgCaseReceiptStore(pg.client),
      datasets,
      cancellations,
      // Wired in its production shape. The seam ANSWERS now (arch-review 52, Wave 3) and `absent` is a
      // converged answer — there is no managed job behind this batch's self-hosted lease lane, which is the
      // honest reading and the one that lets the teardown converge on the revocation alone.
      killCase: async () => ({ status: "absent" as const }),
      cancelLeased: async () => {
        if (revocationFails) throw new Error("runner lease revocation is unreachable");
        revoked.push(1);
        return 0;
      },
    });

    const record = await service.submit({
      tenant,
      dataset: { id: "cancel-set", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      submittedBy: "u-trust",
      concurrency: 2,
    });
    scorecardIds.push(record.id);

    // Wait for the batch to have actually spent compute — cancelling before any child exists would certify
    // the teardown against an empty world.
    const deadline = Date.now() + 15_000;
    let children = await runStore.list(tenant, { scorecardId: record.id });
    while (children.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      children = await runStore.list(tenant, { scorecardId: record.id });
    }
    expect(children.length, "the batch dispatched before it was stopped").toBeGreaterThan(0);

    // ① THE CRASH SHAPE. The decision commits; the teardown throws.
    await expect(service.cancel({ tenant, id: record.id })).rejects.toThrow("runner lease revocation is unreachable");
    expect((await store.get(record.id))?.status, "the DECISION survives a teardown that could not run").toBe(
      "cancelled",
    );
    const owed = (await cancellations.listIncomplete(50)).filter(
      (op) => op.target.kind === "scorecard" && op.target.id === record.id,
    );
    expect(owed, "the teardown is recorded as still owed").toHaveLength(1);
    expect(owed[0]?.state).toBe("requested");
    expect(owed[0]?.lastError).toContain("runner lease revocation is unreachable");
    // The children are exactly what a crashed control plane leaves behind: non-terminal rows for a batch that
    // is already terminal. This is the divergence nothing used to be looking for.
    const stranded = await runStore.list(tenant, { scorecardId: record.id });
    expect(stranded.some((child) => child.status === "running" || child.status === "queued")).toBe(true);

    // ② THE OWNER SHOWS UP. Same idempotent steps, run by whoever swept next — no caller involved.
    revocationFails = false;
    expect(await sweep().reconcile(50)).toBe(1);
    expect(revoked.length, "the reconciler re-ran the revocation the failed teardown owed").toBeGreaterThan(0);
    const settled = await runStore.list(tenant, { scorecardId: record.id });
    expect(settled.length).toBeGreaterThan(0);
    for (const child of settled) {
      expect(child.status, `child ${child.id} reached a terminal state`).toBe("failed");
      expect(child.error?.code).toBe("CANCELLED");
    }
    // …and the row is closed, in Postgres, where the next replica reads it — WITH the certificate that
    // closed it (mig 0186). `completed` used to mean "the teardown function returned"; it means "these
    // postconditions were read back" now, and the row is where an operator finds which ones.
    const { rows } = await pg.client.query<{
      state: string;
      target_kind: string;
      last_error: string | null;
      completed_at: Date | null;
      certificate: { childrenTerminal?: number; kills?: { stopped: number; absent: number } } | null;
    }>(
      "SELECT state, target_kind, last_error, completed_at, certificate FROM everdict_cancellation_operations WHERE scorecard_id = $1",
      [record.id],
    );
    expect(rows[0]?.state).toBe("completed");
    expect(rows[0]?.target_kind).toBe("scorecard");
    expect(rows[0]?.last_error, "the reason described the attempt that failed, not this one").toBeNull();
    expect(rows[0]?.completed_at).not.toBeNull();
    expect(rows[0]?.certificate?.childrenTerminal, "the population the zero-live-children check ran over").toBe(
      settled.length,
    );

    // ③ A COMPLETED OPERATION IS OVER. A sweep that kept finding it would tear the same batch down on every
    // pass for as long as the row exists.
    const revocationsBefore = revoked.length;
    expect(await sweep().reconcile(50)).toBe(0);
    expect(revoked.length, "the second pass is a genuine no-op, not a cheaper repeat").toBe(revocationsBefore);
  }, 90_000);
});
