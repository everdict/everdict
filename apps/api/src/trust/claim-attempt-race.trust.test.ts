import {
  type OpenLeaseAttempt,
  type SelfHostedKey,
  StoreRunnerHub,
  openPhysicalAttempt,
  requiredRunnerCapabilities,
} from "@everdict/application-control";
import type { CaseJob } from "@everdict/contracts";
import {
  PgExecutionAttemptStore,
  type PgPool,
  PgRunnerJobStore,
  type SqlClient,
  makePool,
  sqlClient,
} from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-176.
//
// ONE TRANSITION MINTS A COMPLETE ATTEMPT — PROVED AS A RACE, AGAINST THE DATABASE THAT ARBITRATES IT.
//
// `claimAttempt` (arch-review 47 §5.1) folds the re-lease's four writes into one transaction: the candidate
// claim, the predecessor attempt's supersede, the successor's `executing` insert, and the row's restamp of
// `current_attempt_id`. Every unit that covered it drove the IN-MEMORY twin, whose rollback is a hand-written
// `status = "queued"` in a catch block and whose "race" is an interleaving this repository's own event loop
// decides. Neither half of the claim's actual guarantee is reachable there:
//
//   ① THE ARBITER IS `FOR UPDATE SKIP LOCKED`, AND THE LOCK IS HELD ACROSS THE MINT. The mint is several
//     round-trips (supersede, open, markExecuting), so the losing claimer arrives while the winner's
//     transaction is open — which is exactly the window the transaction exists to close, and exactly the
//     window a single-process twin cannot open at all.
//   ② THE ROLLBACK IS POSTGRES'S. A mint that throws must leave NO trace: no lease, no epoch, no attempt row,
//     and — the half nothing pinned before — a predecessor still `executing`, because the supersede that ran
//     inside the doomed transaction has to come back too. An in-memory twin that manually resets two fields
//     cannot fail that assertion no matter how wrong the real transaction is.
//
// So this drives the REAL `PgRunnerJobStore.claimAttempt` through the REAL `StoreRunnerHub` mint closure
// (`claimWithAttempt`), over two independent connection pools, against a live database.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

const DATABASE_URL = process.env.EVERDICT_TRUST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

// The composition root's claim-lane opener (apps/api/src/composition/dispatch.ts `openLeaseAttemptOn`), in
// the shape a lease sees it: supersede what the ROW named, open the successor through the production
// `openPhysicalAttempt`, stamp it executing under the epoch that authorized it — all through the ledger the
// STORE handed in, which on this lane is the claim transaction's own twin. No recording store is wired, so
// the ledger is the sole ordinal authority and the generation it returns is the attempt's own.
function productionOpener(): OpenLeaseAttempt {
  return async ({ job, leaseEpoch, attempts, prior }) => {
    if (attempts === undefined) throw new Error("the Pg claim lane always binds a transaction-scoped ledger");
    const { runId, tenant } = job;
    if (runId === undefined || tenant === undefined) throw new Error("the fixture job carries both");
    if (prior !== undefined)
      await attempts.transition(prior, "superseded", {
        error: { code: "LEASE_SUPERSEDED", message: "re-leased to another runner" },
      });
    const opened = await openPhysicalAttempt({ attempts }, { executionId: runId, tenant });
    const attemptId = opened.attemptId;
    if (attemptId === undefined) throw new Error("the ledger is wired, so the open carries a row id");
    return {
      ...(opened.generation !== undefined ? { generation: opened.generation } : {}),
      attemptId,
      markExecuting: async () => {
        await attempts.transition(attemptId, "executing", { leaseEpoch });
      },
    };
  };
}

interface JobStateRow {
  status: string;
  leased_by: string | null;
  lease_epoch: number;
  current_attempt_id: string | null;
}

describeTrust("TRUST-176 — a re-lease's claim and its attempt ledger commit as one, or not at all", () => {
  let pg: TrustPg;
  const pools: PgPool[] = [];
  const jobIds: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => {
    if (jobIds.length > 0)
      await pg.client.query("DELETE FROM everdict_runner_jobs WHERE job_id = ANY($1)", [jobIds]).catch(() => undefined);
    if (runIds.length > 0)
      await pg.client
        .query("DELETE FROM everdict_execution_attempts WHERE execution_id = ANY($1)", [runIds])
        .catch(() => undefined);
    for (const pool of pools) await pool.end().catch(() => undefined);
    await pg?.close();
  });

  // An independent connection pool — a claimer that shares no session, no transaction and no lock table with
  // its rival. Two `PgRunnerJobStore`s over one pool would still be two connections, but a pool of their own
  // is what makes each racer a replica rather than a coroutine.
  function replica(deps: { leaseTtlMs: number; now: () => number }): StoreRunnerHub {
    const pool = makePool(DATABASE_URL);
    pools.push(pool);
    return new StoreRunnerHub(new PgRunnerJobStore(sqlClient(pool)), {
      pollMs: 5,
      leaseTtlMs: deps.leaseTtlMs,
      now: deps.now,
      openLeaseAttempt: productionOpener(),
    });
  }

  // One owner per fixture. The claim's candidate SELECT is scoped by owner and ordered FIFO, so a leftover
  // row from an earlier scenario in this same file would be the oldest thing in a shared queue and would be
  // what the next claim takes — the shared-database hazard, in the one place where "which job did I get"
  // is the whole subject.
  function caseJob(owner: string, runId: string): CaseJob {
    return {
      evalCase: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      harness: { id: "scripted", version: "0" },
      tenant: owner,
      runId,
    };
  }

  // Bring a job to the state the race is ABOUT: queued, with `current_attempt_id` naming a live predecessor.
  // Every write here is production's — the park, two real claims (epoch 1 mints nothing; epoch 2 mints the
  // predecessor) — and the last step is the requeue sweep's own statement, run deterministically instead of
  // waiting on a TTL. Fabricating the row by hand is what the suite's rules warn about: a `current_attempt_id`
  // this file wrote would certify the race against a coordinate production never produces.
  async function queuedWithLivePredecessor(): Promise<{ jobId: string; runId: string; key: SelfHostedKey }> {
    const jobId = trustId("job");
    const runId = trustId("evd-run");
    const key: SelfHostedKey = { owner: trustId("trust-claim-owner"), runnerId: "runner-a" };
    jobIds.push(jobId);
    runIds.push(runId);
    const job = caseJob(key.owner, runId);
    const setup = replica({ leaseTtlMs: 0, now: () => Date.now() });
    const store = new PgRunnerJobStore(pg.client);
    await store.park({
      jobId,
      owner: key.owner,
      runnerId: key.runnerId,
      tenant: key.owner,
      job,
      requiredCaps: requiredRunnerCapabilities(job),
      now: Date.now(),
    });
    const first = await setup.leaseWait(key, 500);
    expect(first?.attempt.leaseEpoch, "the first lease runs the attempt the dispatch already opened").toBe(1);
    // leaseTtlMs 0 ⇒ the sweep requeues the lease above, so this is a genuine RE-lease: epoch 2, and the
    // first attempt row the lease lane has ever minted for this job.
    const second = await setup.leaseWait(key, 500);
    expect(second?.attempt.leaseEpoch).toBe(2);
    expect(second?.job.recordingGeneration).toBe(1);
    // The requeue sweep's own write (see PgRunnerJobStore.claimOn), applied at a moment this test chooses.
    await pg.client.query("UPDATE everdict_runner_jobs SET status = 'queued', leased_by = NULL WHERE job_id = $1", [
      jobId,
    ]);
    return { jobId, runId, key };
  }

  const jobState = async (jobId: string): Promise<JobStateRow | undefined> => {
    const { rows } = await pg.client.query<JobStateRow>(
      "SELECT status, leased_by, lease_epoch, current_attempt_id FROM everdict_runner_jobs WHERE job_id = $1",
      [jobId],
    );
    return rows[0];
  };

  const ledger = (client: SqlClient): PgExecutionAttemptStore => new PgExecutionAttemptStore(client);

  it("two replicas racing one re-lease: exactly one claim commits, and the ledger holds exactly one live attempt", async () => {
    const { jobId, runId, key } = await queuedWithLivePredecessor();
    // A TTL nothing can expire — so the only thing that can decide this race is the row lock. If a sweep
    // could requeue the winner's lease the loser would go on to win too, and "exactly one" would be an
    // artifact of timing rather than of the claim.
    const now = () => Date.now();
    const [a, b] = await Promise.all([
      replica({ leaseTtlMs: 600_000, now }).leaseWait(key, 400),
      replica({ leaseTtlMs: 600_000, now }).leaseWait(key, 400),
    ]);

    const winners = [a, b].filter((lease) => lease !== null);
    expect(winners, "one claim commits; the other is skipped over a locked row").toHaveLength(1);
    const won = winners[0];
    if (!won) throw new Error("expected a winner");
    // The successor's identity, all the way through: a third epoch, its own generation, and the row naming it.
    expect(won.attempt.leaseEpoch).toBe(3);
    expect(won.job.recordingGeneration).toBe(2);
    expect(await jobState(jobId)).toMatchObject({
      status: "leased",
      leased_by: "runner-a",
      lease_epoch: 3,
      current_attempt_id: `${runId}#g2`,
    });

    // THE CLAIM'S OTHER HALF: the attempt it replaced is ENDED, by the claim that replaced it. This is the
    // sentence the three-step path structurally could not say — the predecessor's id reached no replica —
    // and the one a losing claimer must not have written a second copy of.
    const attempts = await ledger(pg.client).list(runId);
    expect(attempts.map((attempt) => [attempt.attemptId, attempt.state, attempt.leaseEpoch])).toEqual([
      [`${runId}#g1`, "superseded", 2],
      [`${runId}#g2`, "executing", 3],
    ]);
  }, 60_000);

  it("a mint that throws leaves NOTHING: no lease, no epoch, no attempt row — and the predecessor still executing", async () => {
    const { jobId, runId, key } = await queuedWithLivePredecessor();
    const before = await jobState(jobId);
    expect(before).toMatchObject({ status: "queued", lease_epoch: 2, current_attempt_id: `${runId}#g1` });

    // The ledger is unreachable at the moment of the claim — the fault the transaction exists for. "This
    // runner holds a lease" and "the ledger could not record its attempt" must not both become true.
    const pool = makePool(DATABASE_URL);
    pools.push(pool);
    const hub = new StoreRunnerHub(new PgRunnerJobStore(sqlClient(pool)), {
      pollMs: 5,
      leaseTtlMs: 600_000,
      now: () => Date.now(),
      openLeaseAttempt: async ({ prior, attempts }) => {
        // The supersede lands FIRST and is then thrown over: it is a real write inside the doomed
        // transaction, so the rollback has something to undo rather than an empty statement to discard.
        if (prior !== undefined && attempts !== undefined)
          await attempts.transition(prior, "superseded", {
            error: { code: "LEASE_SUPERSEDED", message: "re-leased to another runner" },
          });
        throw new Error("attempt ledger unreachable");
      },
    });
    await expect(hub.leaseWait(key, 200)).rejects.toThrow("attempt ledger unreachable");

    // The row is byte-for-byte what it was: still claimable, and — the assertion an in-memory rollback
    // cannot make — the epoch did not move either, so no number was burned that a later reader could mistake
    // for a lease somebody held.
    expect(await jobState(jobId)).toMatchObject({
      status: "queued",
      leased_by: null,
      lease_epoch: 2,
      current_attempt_id: `${runId}#g1`,
    });
    // …and the ledger never heard about any of it. The predecessor is LIVE: its supersede rolled back with
    // the claim that wrote it, because an attempt is not ended by a lease that never happened.
    const attempts = await ledger(pg.client).list(runId);
    expect(attempts.map((attempt) => [attempt.attemptId, attempt.state])).toEqual([[`${runId}#g1`, "executing"]]);

    // And the job is genuinely claimable again — a rollback that left the row unwritable would be the same
    // outage in a quieter form.
    const recovered = await replica({ leaseTtlMs: 600_000, now: () => Date.now() }).leaseWait(key, 400);
    expect(recovered?.attempt.leaseEpoch).toBe(3);
    expect((await ledger(pg.client).list(runId)).map((attempt) => attempt.state)).toEqual(["superseded", "executing"]);
  }, 60_000);
});
