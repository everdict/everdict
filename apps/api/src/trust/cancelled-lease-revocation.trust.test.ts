import { requiredRunnerCapabilities } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { PgRunnerJobStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-178.
//
// A CANCEL REVOKES THE CAPABILITY — AND THE THING THAT REVOKES IT IS THE `WHERE` CLAUSE, NOT THE TWIN.
//
// Cancellation on the self-hosted lane is capability revocation (arch-review 46) rather than a notification:
// until the runner complies, its lease authorizes nothing. `outcome` reports a terminal row verbatim, so a
// cancelled job's holder landing its `complete()` erased the cancellation from the record — the batch read
// back "completed" and, on the evidence, the user's stop had never happened.
//
// The store lane's half of that rule lives in five SQL predicates (`NOT cancel_requested` on authorize /
// complete / fail / restamp, and the `CASE` that freezes `activity_at` on touch) plus the terminalizing
// sweep and ack that arch-review 47 P1-2 added so a cancelled row cannot sit in limbo. Everything covering it
// so far either drove the InMemory twin — a hand-written mirror of predicates, which is the one thing that
// cannot certify the predicates — or asserted over SQL TEXT through a fake `SqlClient`, which certifies a
// string. This drives the real `PgRunnerJobStore` against a live database and asks the database.
//
// One job per claim on purpose: `complete` and `fail` TERMINALIZE the row as their own ack, so asserting
// them in sequence on one row would be asserting the ack, not the revocation.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

const result = (caseId: string): CaseResult => ({
  caseId,
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [],
});

interface RowState {
  status: string;
  cancel_requested: boolean;
  activity_ms: string;
}

describeTrust("TRUST-178 — a cancelled lease authorizes nothing, and the row it holds still ends", () => {
  let pg: TrustPg;
  let store: PgRunnerJobStore;
  const jobIds: string[] = [];

  beforeAll(async () => {
    pg = await openTrustPg();
    store = new PgRunnerJobStore(pg.client);
  });
  afterAll(async () => {
    if (jobIds.length > 0)
      await pg.client.query("DELETE FROM everdict_runner_jobs WHERE job_id = ANY($1)", [jobIds]).catch(() => undefined);
    await pg?.close();
  });

  const caseJob = (owner: string, caseId: string): CaseJob => ({
    evalCase: { id: caseId, env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    harness: { id: "scripted", version: "0" },
    tenant: owner,
  });

  // A leased job, then a cancel: the state every assertion below starts from. Each fixture gets its own
  // owner so the claim's FIFO candidate SELECT can only ever see its own row.
  async function leasedThenCancelled(caseId: string): Promise<{ jobId: string; owner: string; epoch: number }> {
    const jobId = trustId("job-rev");
    const owner = trustId("trust-rev-owner");
    jobIds.push(jobId);
    const job = caseJob(owner, caseId);
    await store.park({
      jobId,
      owner,
      runnerId: "runner-a",
      tenant: owner,
      job,
      requiredCaps: requiredRunnerCapabilities(job),
      now: Date.now(),
    });
    const lease = await store.claim({ owner, runnerId: "runner-a", leaseTtlMs: 600_000, now: Date.now() });
    if (!lease) throw new Error("expected the fixture's own job to be claimable");
    expect(await store.cancel((candidate) => candidate.evalCase.id === caseId)).toBe(1);
    return { jobId, owner, epoch: lease.leaseEpoch };
  }

  const rowOf = async (jobId: string): Promise<RowState | undefined> => {
    const { rows } = await pg.client.query<RowState>(
      `SELECT status, cancel_requested, extract(epoch from activity_at) * 1000 AS activity_ms
         FROM everdict_runner_jobs WHERE job_id = $1`,
      [jobId],
    );
    return rows[0];
  };

  it("the evidence door closes: a cancelled lease no longer authorizes, and cannot restamp its own job", async () => {
    const { jobId, owner, epoch } = await leasedThenCancelled("c-auth");
    // `authorize` is what every later evidence push is answered out of. It shares its predicate with the
    // mutations precisely so the evidence wire and the result wire revoke together.
    expect(await store.authorize(jobId, "runner-a", epoch)).toBeNull();
    expect(await store.restampJob(jobId, "runner-a", epoch, caseJob(owner, "c-auth"))).toBe(false);
    // A refused read must not itself terminalize — only a REPORT is an ack. A row this runner is still being
    // asked to abort has to keep its holder's identity so the heartbeat can carry the signal.
    expect(await rowOf(jobId)).toMatchObject({ status: "leased", cancel_requested: true });
  }, 60_000);

  it("a cancelled holder's completion is refused BY POSTGRES, and the refusal is the ack that ends the row", async () => {
    const { jobId } = await leasedThenCancelled("c-complete");
    expect(await store.complete(jobId, result("c-complete"), "runner-a", 1)).toBe(false);
    // The outcome the parking replica reads is CANCELLED — never the "completed" a successful late write
    // would have made it. This is the exact erasure the predicate exists to prevent.
    const outcome = await store.outcome(jobId);
    expect(outcome?.status).toBe("cancelled");
    expect(outcome?.result, "a refused write leaves no payload to disagree with the status").toBeUndefined();
    // …and limbo is not a state: the refused report IS the ack, so the row reaches a persisted terminal.
    expect(await rowOf(jobId)).toMatchObject({ status: "cancelled" });
  }, 60_000);

  it("…and so is its failure report — a cancelled lease may not end the job with its own error either", async () => {
    const { jobId } = await leasedThenCancelled("c-fail");
    expect(await store.fail(jobId, "the sandbox died", "runner-a", 1)).toBe(false);
    const outcome = await store.outcome(jobId);
    expect(outcome?.status).toBe("cancelled");
    expect(outcome?.error, "the job's ending is the cancel, not the runner's excuse for it").toBeUndefined();
    expect(await rowOf(jobId)).toMatchObject({ status: "cancelled" });
  }, 60_000);

  it("the heartbeat still ANSWERS a cancelled lease — that reply is the abort channel — but stops extending it", async () => {
    const { jobId } = await leasedThenCancelled("c-touch");
    const before = await rowOf(jobId);
    // A full minute later: a compliant heartbeat would move activity_at by that much.
    const heartbeat = await store.touch(jobId, "runner-a", 1, Date.now() + 60_000);
    expect(heartbeat).toEqual({ extended: false, cancelled: true });
    const after = await rowOf(jobId);
    // FROZEN, deliberately. A runner that hears the cancel and keeps heartbeating anyway must stop looking
    // alive, so the idle-timeout path can reclaim the job instead of it being renewed for ever.
    expect(Number(after?.activity_ms)).toBe(Number(before?.activity_ms));
    expect(after).toMatchObject({ status: "leased", cancel_requested: true });
  }, 60_000);

  it("the TTL sweep terminalizes a cancelled lease its runner never acked — excluded from requeue is not ended", async () => {
    const { jobId, owner } = await leasedThenCancelled("c-sweep");
    // The claim path runs both sweeps. A cancelled expired lease is skipped by the REQUEUE sweep (never
    // re-dispatch work the control plane stopped) and by the candidate SELECT — which is exactly how it used
    // to end up owned by nobody, `leased` for ever with a flag on it.
    const claimed = await store.claim({ owner, runnerId: "runner-a", leaseTtlMs: 1, now: Date.now() + 60_000 });
    expect(claimed, "a cancelled job is never re-dispatched").toBeNull();
    expect(await rowOf(jobId)).toMatchObject({ status: "cancelled" });
  }, 60_000);

  it("a cancelling lease is not pending work — the queue depth stops counting it the moment the cancel lands", async () => {
    const { jobId, owner } = await leasedThenCancelled("c-pending");
    expect(await store.pending(owner, "runner-a")).toBe(0);
    // …and the row is still there to be acked: "not counted" is a statement about backpressure, not a delete.
    expect(await rowOf(jobId)).toMatchObject({ status: "leased", cancel_requested: true });
  }, 60_000);
});
