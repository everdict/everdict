import type { CaseJob } from "@everdict/contracts";
import { PgRunnerJobStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-188: a busy runner's liveness keeps the jobs QUEUED
// behind it alive, on real Postgres (arch-review 119).
//
// The store lane enforces the idle timeout per job off that row's `activity_at`, and the only two statements
// that wrote it were keyed by `job_id` — the claim of that job and the heartbeat of that job. Nothing
// refreshed a job still queued, so a self-hosted job behind a long-running one was rejected
//
//     "No self-hosted runner activity — the runner is not connected, is idle/dead, …"
//
// while its runner was connected, capable and working. The in-memory hub has always had `rearmWaiting`; this
// lane took the argument as `_capabilities` and its class header claimed the behaviour anyway.
//
// ⚠️ ONLY REAL POSTGRES CAN CERTIFY THIS HALF. The decision is the statement's own `WHERE`: an array
// containment gate (`required_caps <@ $5::text[]`), an own-queue-or-pool disjunction, and a monotonicity
// guard comparing a timestamptz to an epoch-milliseconds parameter. A fake client evaluates none of that —
// the unit twin pins the shape, this pins the statement (rule `testing`).
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-188 — a busy runner's queue stays alive, and only what it could take", () => {
  let pg: TrustPg;
  let store: PgRunnerJobStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    store = new PgRunnerJobStore(pg.client);
  });
  afterAll(async () => pg?.close());

  // The production shape, because the store PARSES the stored job on the way back out — the first version of
  // this fixture was `{ caseId, tenant }` and every read raised a ZodError instead of an assertion.
  const job = (runId: string): CaseJob => ({
    evalCase: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    harness: { id: "scripted", version: "0" },
    tenant: "acme",
    runId,
  });
  const activityOf = async (jobId: string): Promise<number> => (await store.outcome(jobId))?.activityAt ?? -1;

  it("refreshes a QUEUED sibling, leaves a leased row alone, and skips what the runner cannot run", async () => {
    const owner = trustId("owner");
    const runner = trustId("runner");
    const t0 = Date.now();
    const held = trustId("job");
    const waiting = trustId("job");
    const pooled = trustId("job");
    const gpu = trustId("job");
    await store.park({ jobId: held, owner, runnerId: runner, job: job("held"), requiredCaps: [], now: t0 });
    await store.park({ jobId: waiting, owner, runnerId: runner, job: job("waiting"), requiredCaps: [], now: t0 });
    // The owner POOL ('*') is refreshed too — a pinned runner drains it, so its liveness covers it.
    await store.park({ jobId: pooled, owner, runnerId: "*", job: job("pooled"), requiredCaps: [], now: t0 });
    await store.park({ jobId: gpu, owner, runnerId: runner, job: job("gpu"), requiredCaps: ["gpu"], now: t0 });

    const lease = await store.claim({ owner, runnerId: runner, leaseTtlMs: 120_000, now: t0 });
    expect(lease?.jobId, "the claim did not take the first queued job").toBe(held);

    // …the runner is still working, well past the idle timeout, and advertises no gpu.
    const later = t0 + 600_000;
    const refreshed = await store.touchWaiting({ owner, runnerId: runner, advertisedCaps: [], now: later });

    expect(refreshed, "the refresh did not reach exactly the two claimable queued rows").toBe(2);
    expect(await activityOf(waiting), "the job queued behind the running one was left to age out").toBe(later);
    expect(await activityOf(pooled), "the owner pool was not covered by its runner's liveness").toBe(later);
    expect(
      await activityOf(gpu),
      "an incapable runner kept alive a job it could never claim — it would pend for ever",
    ).toBe(t0);
    // The leased row keeps its own clock: `touch` owns that, and a queue refresh must not extend a lease.
    expect(await activityOf(held), "a queue refresh extended a LEASE it does not own").toBe(t0);
  });

  it("is MONOTONIC — a replica with a lagging clock cannot pull liveness backwards", async () => {
    // Several replicas write this column and their clocks are not one clock. A refresh that moved
    // `activity_at` back would push a live job toward the timeout it is being kept out of.
    const owner = trustId("owner");
    const runner = trustId("runner");
    const t0 = Date.now();
    const id = trustId("job");
    await store.park({ jobId: id, owner, runnerId: runner, job: job("w"), requiredCaps: [], now: t0 });

    await store.touchWaiting({ owner, runnerId: runner, now: t0 + 60_000 });
    const behind = await store.touchWaiting({ owner, runnerId: runner, now: t0 + 10_000 });

    expect(behind, "a lagging replica's refresh claimed rows it must not touch").toBe(0);
    expect(await activityOf(id), "a lagging clock pulled a job's liveness backwards").toBe(t0 + 60_000);
  });

  it("refreshes EVERYTHING claimable when the runner advertises nothing — a pre-capability runner", async () => {
    // `advertisedCaps` undefined is "this runner does not say", which must keep the old refresh-all behaviour
    // rather than becoming "it can run nothing" — that reading would time out every job on an older runner.
    const owner = trustId("owner");
    const runner = trustId("runner");
    const t0 = Date.now();
    const gpu = trustId("job");
    await store.park({ jobId: gpu, owner, runnerId: runner, job: job("g"), requiredCaps: ["gpu"], now: t0 });

    const refreshed = await store.touchWaiting({ owner, runnerId: runner, now: t0 + 60_000 });

    expect(refreshed, "a runner that advertises nothing was read as able to run nothing").toBe(1);
    expect(await activityOf(gpu)).toBe(t0 + 60_000);
  });

  it("leaves a CANCELLED queued row alone — it is not waiting for a runner", async () => {
    const owner = trustId("owner");
    const runner = trustId("runner");
    const t0 = Date.now();
    const id = trustId("job");
    const marker = trustId("case");
    await store.park({ jobId: id, owner, runnerId: runner, job: job(marker), requiredCaps: [], now: t0 });
    await store.cancel((j) => (j as { runId?: string }).runId === marker);

    const refreshed = await store.touchWaiting({ owner, runnerId: runner, now: t0 + 60_000 });

    expect(refreshed, "a cancelled row was kept alive as though a runner were coming for it").toBe(0);
  });

  it("does not reach ANOTHER owner's queue", async () => {
    const owner = trustId("owner");
    const runner = trustId("runner");
    const other = trustId("owner");
    const t0 = Date.now();
    const id = trustId("job");
    await store.park({ jobId: id, owner: other, runnerId: runner, job: job("x"), requiredCaps: [], now: t0 });

    const refreshed = await store.touchWaiting({ owner, runnerId: runner, now: t0 + 60_000 });

    expect(refreshed, "one workspace's runner refreshed another workspace's queue").toBe(0);
    expect(await activityOf(id)).toBe(t0);
  });
});
