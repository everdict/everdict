import { PgExecutionAttemptStore, PgScorecardStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// ── A BATCH'S VERIFIER RESERVES AGAINST REAL POSTGRES (arch-review 58 P0, A- condition 5) ────────────
//
// The verifier opens its OWN attempt row — the agent's is committed by the time a verdict exists — and until
// arch-review 58 it opened that row with no parent. `PARENT_AUTHORIZES` asks whether the attempt's parent is
// still open, and with `scorecard_id IS NULL` it takes the RUN branch:
//
//     'evd-run-' || r.id = a.execution_id
//
// A batch case's execution id is `evd-<batchId>-<caseId>[-t<n>]`, which no run row can ever equal. So the
// guard written to refuse a CANCELLED parent refused a LIVE one, on every batch verifier — and single runs
// were unaffected, their execution id really being `evd-run-<id>`, which is exactly why it read as working.
//
// That is a defect no unit test could reach. The in-memory twin has no `PARENT_AUTHORIZES` to take the wrong
// branch of, and a fake `SqlClient` answers whatever it is asked. The claim is about a SQL predicate against
// a real schema, so this scenario lives in the `trust fast (real Postgres)` lane, which is a required check
// and which `pnpm ci:local` deliberately cannot cover.
//
// Both directions matter here. The reservation must SUCCEED under a live batch (that is the fix), and it must
// still be REFUSED once the batch is settled (that is what the guard is for, and a fix that bought the first
// by weakening the second would be worse than the defect).
//
// RED as of 26147830, observed:
//   the verifier could not reserve work under its own live batch: expected undefined to be defined

describe.skipIf(!TRUST_PG_ENABLED)("TRUST — a batch's verifier reserves under its own parent", () => {
  let pg: TrustPg;
  let attempts: PgExecutionAttemptStore;
  let scorecards: PgScorecardStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    attempts = new PgExecutionAttemptStore(pg.client);
    scorecards = new PgScorecardStore(pg.client);
  });
  afterAll(async () => {
    await pg?.close();
  });

  const openBatch = async (id: string, status: "running" | "cancelled") => {
    await scorecards.create({
      id,
      tenant: "acme",
      kind: "scorecard",
      status: "running",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1" },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as never);
    if (status === "cancelled") await scorecards.update(id, { status: "cancelled" } as never);
  };

  // The verifier's row, as `verifierOperation` opens one: the batch's execution id, the batch as parent, and
  // the `#verify` case suffix that keeps the two units distinguishable in a ledger read.
  const openVerifierAttempt = async (batchId: string, opts: { withParent: boolean; driverEpoch?: number }) => {
    const executionId = `evd-${batchId}-c1-t0`;
    const { attemptId } = await attempts.open({
      executionId,
      tenant: "acme",
      caseId: "c1#verify",
      ...(opts.withParent ? { scorecardId: batchId } : {}),
      ...(opts.driverEpoch !== undefined ? { driverEpoch: opts.driverEpoch } : {}),
    });
    return { attemptId, executionId };
  };

  it("reserves and activates while the batch is live", async () => {
    const batchId = trustId("sc-verify");
    await openBatch(batchId, "running");
    const { attemptId } = await openVerifierAttempt(batchId, { withParent: true });

    const work = { tenant: "acme", runId: `evd-${batchId}-c1-t0`, externalJobId: "verify-1", attemptId };
    const intent = await attempts.reserveWork(attemptId, work);
    expect(intent, "the verifier could not reserve work under its own live batch").toBeDefined();
    expect(intent.attemptId).toBe(attemptId);

    // …and the re-presentation at the container's birth, which is the same predicate one transition later.
    const decision = await attempts.activateWork(attemptId, work);
    expect(decision.kind, "a live batch refused its own verifier's activation").toBe("activate");
  });

  it("REFUSES a verifier whose batch was cancelled before the container was born", async () => {
    // The guard's whole purpose. A cancellation that certified zero must not be followed by a birth.
    const batchId = trustId("sc-verify-cancelled");
    await openBatch(batchId, "cancelled");
    const { attemptId } = await openVerifierAttempt(batchId, { withParent: true });

    await expect(
      attempts.reserveWork(attemptId, {
        tenant: "acme",
        runId: `evd-${batchId}-c1-t0`,
        externalJobId: "verify-2",
        attemptId,
      }),
      "a settled batch authorized a new verifier container",
    ).rejects.toThrow();
  });

  it("shows WHY a parentless verifier row could never reserve — the defect, against the real predicate", async () => {
    // Opened the way arch-review 57 left it: no `scorecard_id`, so `PARENT_AUTHORIZES` looks for a run whose
    // id makes `'evd-run-' || r.id` equal a BATCH execution id. Nothing can satisfy that, which is why the
    // parent coordinate had to travel rather than being nice-to-have.
    const batchId = trustId("sc-verify-orphan");
    await openBatch(batchId, "running");
    const { attemptId } = await openVerifierAttempt(batchId, { withParent: false });

    await expect(
      attempts.reserveWork(attemptId, {
        tenant: "acme",
        runId: `evd-${batchId}-c1-t0`,
        externalJobId: "verify-3",
        attemptId,
      }),
    ).rejects.toThrow();
  });

  it("lets the batch's teardown enumerate the verifier it placed", async () => {
    // The other half of carrying the parent: `listForScorecard` is the read a cancellation builds its workset
    // from, and a row it cannot see is a container the teardown certifies gone without looking for it.
    const batchId = trustId("sc-verify-list");
    await openBatch(batchId, "running");
    const { attemptId } = await openVerifierAttempt(batchId, { withParent: true });
    await attempts.reserveWork(attemptId, {
      tenant: "acme",
      runId: `evd-${batchId}-c1-t0`,
      externalJobId: "verify-4",
      attemptId,
    });

    const owned = await attempts.listForScorecard(batchId);
    expect(owned, "a scorecard teardown cannot see its own verifier attempt").toHaveLength(1);
    expect(owned[0]?.runtimeWork?.externalJobId).toBe("verify-4");
  });

  it("REFUSES a verifier whose drive was taken over — the epoch is what says so", async () => {
    // arch-review 59 P0-verifier. `PARENT_AUTHORIZES` compares the parent's epoch only when the attempt has
    // one: `a.driver_epoch IS NULL OR s.owner_epoch = a.driver_epoch`. Opened without it, a displaced
    // replica's verifier satisfies the predicate under ANY owner and can still burn tenant compute with the
    // tenant's image and the verifier's credentials — the child settle is refused later by a different fence,
    // which is exactly why it reads as harmless until the bill.
    //
    // This is the half no unit test can reach: the comparison is a SQL predicate against a real row.
    const batchId = trustId("sc-verify-epoch");
    await openBatch(batchId, "running");
    // The batch is now owned at a higher epoch than the replica that opened this attempt was driving under.
    await pg.client.query("UPDATE everdict_scorecards SET owner_epoch = 6 WHERE id = $1", [batchId]);
    const { attemptId } = await openVerifierAttempt(batchId, { withParent: true, driverEpoch: 5 });

    await expect(
      attempts.reserveWork(attemptId, {
        tenant: "acme",
        runId: `evd-${batchId}-c1-t0`,
        externalJobId: "verify-stale",
        attemptId,
      }),
      "a displaced replica reserved compute under a batch it no longer drives",
    ).rejects.toThrow();
  });

  it("still reserves when the epoch is the one the parent is being driven under", async () => {
    const batchId = trustId("sc-verify-epoch-ok");
    await openBatch(batchId, "running");
    await pg.client.query("UPDATE everdict_scorecards SET owner_epoch = 5 WHERE id = $1", [batchId]);
    const { attemptId } = await openVerifierAttempt(batchId, { withParent: true, driverEpoch: 5 });
    const intent = await attempts.reserveWork(attemptId, {
      tenant: "acme",
      runId: `evd-${batchId}-c1-t0`,
      externalJobId: "verify-live",
      attemptId,
    });
    expect(intent.attemptId).toBe(attemptId);
  });
});
