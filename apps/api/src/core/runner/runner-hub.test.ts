import { RunnerHub, type SelfHostedKey, poolKeyFor } from "@everdict/application-control";
import { type AgentJob, type CaseResult, RateLimitError } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const job = (id: string): AgentJob => ({
  evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
});
// A job requiring case.image — container execution, so the runner needs the docker capability.
const imageJob = (id: string): AgentJob => ({
  ...job(id),
  evalCase: { ...job(id).evalCase, image: "spreadsheetbench:v1" },
});
const keyA: SelfHostedKey = { owner: "u-alice", runnerId: "laptop" };
const keyB: SelfHostedKey = { owner: "u-bob", runnerId: "laptop" };
// Two runners in u-alice's POOL — a capable one (docker) that will "die" and an incapable survivor (no docker).
const poolA = poolKeyFor("u-alice");
const capableRunner: SelfHostedKey = { owner: "u-alice", runnerId: "capable" };
const incapableRunner: SelfHostedKey = { owner: "u-alice", runnerId: "incapable" };

describe("RunnerHub", () => {
  it("enqueue parks → lease takes → complete resolves the dispatch promise with the result", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const dispatched = hub.enqueue(keyA, job("c1")); // parked (not resolved yet)

    const leased = hub.lease(keyA);
    expect(leased).toEqual({ jobId: "j-0", job: job("c1") });
    expect(hub.lease(keyA)).toBeNull(); // already leased → none left

    expect(hub.complete(keyA, "j-0", result)).toBe(true);
    await expect(dispatched).resolves.toMatchObject({ result });
  });

  it("onLease fires once when a runner first takes the job — not at park (the queued→running flip signal)", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}`, leaseTtlMs: 1 });
    const onLease = vi.fn();
    hub.enqueue(keyA, job("c1"), onLease);
    expect(onLease).not.toHaveBeenCalled(); // parked, not started — the run stays "waiting"

    hub.lease(keyA);
    expect(onLease).toHaveBeenCalledTimes(1); // a runner took it → the case actually started

    // A requeue (runner died) followed by a re-lease must not re-fire — the run is already running.
    await new Promise((r) => setTimeout(r, 5)); // let the lease TTL lapse so requeueExpired frees it
    hub.lease(keyA);
    expect(onLease).toHaveBeenCalledTimes(1);
  });

  it("onLease fires for a pool (self:ws) job when any runner drains it", () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const owner = "ws:acme";
    const onLease = vi.fn();
    hub.enqueue(poolKeyFor(owner), job("c1"), onLease);
    expect(onLease).not.toHaveBeenCalled();
    // A concrete runner of that owner leases from the pool.
    hub.lease({ owner, runnerId: "box-1" });
    expect(onLease).toHaveBeenCalledTimes(1);
  });

  it("lease rotates fairly across batches — one big batch can't drain before another user's job (WFQ)", () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const batchJob = (id: string, batchId: string): AgentJob => ({ ...job(id), batchId, priority: "batch" });
    // Batch A's three cases are all parked before batch B's single case.
    hub.enqueue(keyA, batchJob("a1", "A"));
    hub.enqueue(keyA, batchJob("a2", "A"));
    hub.enqueue(keyA, batchJob("a3", "A"));
    hub.enqueue(keyA, batchJob("b1", "B"));
    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push(hub.lease(keyA)?.job.evalCase.id ?? "none");
    // Not a1,a2,a3,b1 (pure FIFO) — B's lone case is served on the second lease, not after all of A.
    expect(order).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("an interactive job jumps ahead of parked batch fan-out (priority) — a person waiting doesn't sit behind 601 cases", () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    hub.enqueue(keyA, { ...job("b1"), batchId: "A", priority: "batch" });
    hub.enqueue(keyA, { ...job("b2"), batchId: "A", priority: "batch" });
    hub.enqueue(keyA, { ...job("i1"), priority: "interactive" }); // a single run — a person is waiting
    expect(hub.lease(keyA)?.job.evalCase.id).toBe("i1"); // leased first despite arriving last
  });

  it("backpressure — a full runner queue rejects further parks with RateLimitError(429), never an unbounded pile-up", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}`, maxWaitingPerKey: 2 });
    const p1 = hub.enqueue(keyA, job("c1"));
    const p2 = hub.enqueue(keyA, job("c2"));
    p1.catch(() => {}); // parked (pending) — silence the unhandled-rejection guard for the teardown
    p2.catch(() => {});
    await expect(hub.enqueue(keyA, job("c3"))).rejects.toBeInstanceOf(RateLimitError);
    // Leasing one frees a slot → a new park is admitted again.
    hub.lease(keyA);
    const p4 = hub.enqueue(keyA, job("c4"));
    p4.catch(() => {});
    await expect(Promise.race([p4, Promise.resolve("pending")])).resolves.toBe("pending"); // admitted (still parked)
  });

  it("lease is FIFO; owner (key) isolation — another owner's jobs are invisible", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const a1 = hub.enqueue(keyA, job("a1"));
    hub.enqueue(keyA, job("a2"));
    hub.enqueue(keyB, job("b1"));

    // keyB's lease can't see keyA's jobs (isolation).
    expect(hub.lease(keyB)?.job.evalCase.id).toBe("b1");
    // keyA is FIFO — a1 first.
    expect(hub.lease(keyA)?.job.evalCase.id).toBe("a1");
    expect(hub.lease(keyA)?.job.evalCase.id).toBe("a2");

    hub.complete(keyA, "j-0", result);
    await expect(a1).resolves.toMatchObject({ result });
  });

  it("fail rejects the dispatch promise with an UpstreamError", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-x" });
    const d = hub.enqueue(keyA, job("c1"));
    hub.lease(keyA);
    expect(hub.fail(keyA, "j-x", "failed on the runner")).toBe(true);
    await expect(d).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 502 });
  });

  // Lifecycle leak sentinel: under sustained batch + runner churn the bookkeeping maps must return to ~empty, not
  // grow monotonically. Pre-fix, groupLastServed kept one entry per (queue, batch) forever and queues/waiters kept
  // an empty [] per runner key ever seen — an unbounded leak on a long-running control plane processing many jobs.
  it("bookkeeping maps return to empty after churning many batches across many runner keys (no leak)", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    for (let b = 0; b < 200; b++) {
      const runner: SelfHostedKey = { owner: "u-alice", runnerId: `runner-${b}` }; // a fresh runner id each round (churn)
      const cases = [0, 1, 2].map((c) => ({ ...job(`b${b}-c${c}`), batchId: `batch-${b}` })); // a distinct batch group
      const settled = cases.map((jb) => {
        const d = hub.enqueue(runner, jb);
        d.catch(() => {});
        return d;
      });
      for (let c = 0; c < cases.length; c++) {
        const leased = hub.lease(runner, ["git"]);
        expect(leased).not.toBeNull();
        if (leased) hub.complete(runner, leased.jobId, result);
      }
      await Promise.all(settled);
    }
    const sizes = hub.bookkeepingSize();
    // Everything completed → live state is empty. A tiny constant slack would be fine; exact-zero proves the cleanup.
    expect(sizes).toEqual({ queues: 0, groups: 0, waiters: 0 });
  });

  it("complete/fail with an unknown jobId returns false (already completed/expired)", () => {
    const hub = new RunnerHub();
    expect(hub.complete(keyA, "nope", result)).toBe(false);
    expect(hub.fail(keyA, "nope", "x")).toBe(false);
  });

  // Placement gate: leasing a case.image (container) job to a runner without docker would run it in the wrong environment (host fallback) → reject.
  it("gate: image job + runner without docker → don't lease, reject that job as capability_mismatch", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    const d = hub.enqueue(keyA, imageJob("c-img"));
    const settled = d.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    // The runner only advertises repo (no docker) → it can't run this job → null (nothing to take) + the job is rejected.
    expect(hub.lease(keyA, ["repo"])).toBeNull();
    const r = await settled;
    expect(r).toMatchObject({
      ok: false,
      e: { code: "UPSTREAM_ERROR", extra: { reason: "capability_mismatch", missing: ["docker"] } },
    });
  });

  it("gate: image job + docker runner → leases normally", () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    hub.enqueue(keyA, imageJob("c-img"));
    expect(hub.lease(keyA, ["repo", "docker"])?.job.evalCase.id).toBe("c-img");
  });

  it("gate: no capabilities passed → no gate (backward compatible) — image job leases too", () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    hub.enqueue(keyA, imageJob("c-img"));
    expect(hub.lease(keyA)?.job.evalCase.id).toBe("c-img"); // capabilities undefined → gate skipped
  });

  // Regression (never pending forever): a POOL image job's only capable runner dies; a surviving INCAPABLE runner
  // keeps heartbeating other work. Pre-fix, touchByRunner refreshed EVERY queued job on any heartbeat, so the
  // image job the survivor can't run was kept alive forever — leased by no one, never timing out. Post-fix the
  // heartbeat only keeps alive jobs the runner could run, so the orphaned image job times out → rejected as
  // no_runner (a bounded, explicit failure a batch retry re-parks) instead of pending forever.
  it("a pool job whose only capable runner died is NOT kept alive forever by an incapable survivor's heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 100, newJobId: () => "j-orphan" });
      const d = hub.enqueue(poolA, imageJob("c-img")); // parked in the pool; needs docker
      const settled = d.then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      // The capable runner is gone from the start; only the incapable (no docker) survivor polls + heartbeats other work.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(30); // 180ms total, well past queueTimeoutMs (100)
        expect(hub.lease(incapableRunner, ["git"])).toBeNull(); // can't run the image job → skips it
        hub.heartbeat(incapableRunner, "none", ["git"]); // liveness, but it can't run the image job
      }
      const r = await settled;
      expect(r).toMatchObject({ ok: false, e: { extra: { reason: "no_runner" } } }); // bounded failure, not eternal pending
    } finally {
      vi.useRealTimers();
    }
  });

  // The dual: a CAPABLE survivor's heartbeat DOES keep the queued job alive (it will run once the runner frees up).
  it("a pool job IS kept alive by a capable runner's heartbeat while it drains other work", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const hub = new RunnerHub({ queueTimeoutMs: 100, newJobId: () => `j-${n++}` });
      hub.enqueue(poolA, imageJob("c-a")); // j-0 — the capable runner takes this
      const dB = hub.enqueue(poolA, imageJob("c-b")); // j-1 — waits behind it
      dB.catch(() => {});
      expect(hub.lease(capableRunner, ["git", "docker"])?.jobId).toBe("j-0");
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(30); // 180ms > queueTimeoutMs
        hub.heartbeat(capableRunner, "j-0", ["git", "docker"]); // capable → keeps j-1 alive
      }
      hub.complete(capableRunner, "j-0", result);
      expect(hub.lease(capableRunner, ["git", "docker"])?.jobId).toBe("j-1"); // still there, leasable
      hub.complete(capableRunner, "j-1", result);
      await expect(dB).resolves.toMatchObject({ result });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gate: reject the image job but the same runner leases the following non-image job normally", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const dImg = hub.enqueue(keyA, imageJob("c-img")); // j-0 (needs docker)
    dImg.catch(() => {}); // will be rejected — prevent unhandled
    hub.enqueue(keyA, job("c-plain")); // j-1 (no image)
    // Runner without docker: skips the image job (rejecting it), then takes the non-image job.
    expect(hub.lease(keyA, ["repo"])?.job.evalCase.id).toBe("c-plain");
    await expect(dImg).rejects.toMatchObject({ extra: { reason: "capability_mismatch" } });
  });

  it("timeout: if no runner takes it, reject as no_runner", async () => {
    const hub = new RunnerHub({ queueTimeoutMs: 5 });
    await expect(hub.enqueue(keyA, job("c1"))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      extra: { reason: "no_runner" },
    });
  });

  it("timeout: even if the reject is swallowed, the cause and wait time are surfaced via console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 5, newJobId: () => "j-timeout" });
      await hub.enqueue(keyA, job("c1")).catch(() => {}); // swallow the reject (reproduce a silent failure)
      expect(warn).toHaveBeenCalledOnce();
      const msg = String(warn.mock.calls[0]?.[0]);
      expect(msg).toContain("self:u-alice:laptop"); // which runner
      expect(msg).toContain("5ms"); // how long it waited
      expect(msg).toContain("j-timeout"); // which job
    } finally {
      warn.mockRestore();
    }
  });

  it("the idle timeout is reset by lease/heartbeat — a long-running job (codex etc.) isn't rejected while heartbeating", async () => {
    vi.useFakeTimers();
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 100, newJobId: () => "j-long" });
      const d = hub.enqueue(keyA, job("c1"));
      let rejected = false;
      d.catch(() => {
        rejected = true; // mark if rejected (also prevents unhandled)
      });
      expect(hub.lease(keyA)?.jobId).toBe("j-long"); // runner took it → timeout reset
      // Even well past queueTimeoutMs (100), a heartbeat every 30ms resets it → not rejected (300ms elapsed total).
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30);
        expect(hub.heartbeat(keyA, "j-long").extended).toBe(true);
      }
      expect(rejected).toBe(false);
      expect(hub.complete(keyA, "j-long", result)).toBe(true);
      await expect(d).resolves.toMatchObject({ result });
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: a busy maxConcurrent=1 runner draining a scorecard serially — the jobs queued behind the running one
  // must NOT be rejected as "no runner connected" while the runner is alive and heartbeating the job it is on.
  it("a job waiting behind a busy runner is kept alive by that runner's heartbeat on the running job (not wrongly rejected)", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const hub = new RunnerHub({ queueTimeoutMs: 100, newJobId: () => `j-${n++}` });
      hub.enqueue(keyA, job("c1")); // j-0 — leased & run first
      const d2 = hub.enqueue(keyA, job("c2")); // j-1 — waits behind c1
      let rejected2 = false;
      d2.catch(() => {
        rejected2 = true; // mark if wrongly rejected (also prevents unhandled)
      });
      expect(hub.lease(keyA)?.jobId).toBe("j-0"); // runner takes c1 (serial); c2 stays queued
      // The runner spends >queueTimeoutMs on c1, heartbeating it every 30ms; c2 sits un-leased the whole time (300ms total).
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30);
        expect(hub.heartbeat(keyA, "j-0").extended).toBe(true);
      }
      expect(rejected2).toBe(false); // pre-fix: c2's idle timer never resets → wrongly rejected; post-fix: kept alive
      // Runner finishes c1, then leases c2 and completes it normally.
      hub.complete(keyA, "j-0", result);
      expect(hub.lease(keyA)?.jobId).toBe("j-1");
      hub.complete(keyA, "j-1", result);
      await expect(d2).resolves.toMatchObject({ result });
    } finally {
      vi.useRealTimers();
    }
  });

  it("if the heartbeat stops after leasing (runner death), reject as no_runner after the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 50, newJobId: () => "j-dead" });
      const d = hub.enqueue(keyA, job("c1"));
      // Attach the handler before advancing timers (so the timer reject doesn't leak as unhandled).
      const settled = d.then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      hub.lease(keyA); // took it but no heartbeat afterward (runner death)
      await vi.advanceTimersByTimeAsync(60); // past the 50ms idle window
      const r = await settled;
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ e: { code: "UPSTREAM_ERROR", extra: { reason: "no_runner" } } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lease expiry → requeue: on runner death the next lease takes the same job again", async () => {
    let t = 0;
    const hub = new RunnerHub({ newJobId: () => "j1", now: () => t, leaseTtlMs: 100 });
    hub.enqueue(keyA, job("c1"));
    expect(hub.lease(keyA)?.jobId).toBe("j1"); // runner A takes it (t=0)
    expect(hub.lease(keyA)).toBeNull(); // still leased — none left
    t = 50; // within TTL — not requeued yet
    expect(hub.lease(keyA)).toBeNull();
    t = 201; // past TTL (100) — requeued, can be taken again
    expect(hub.lease(keyA)?.jobId).toBe("j1");
  });

  it("leaseWait: immediate if a job exists; otherwise the next enqueue wakes it (long-poll)", async () => {
    let m = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${m++}` });
    // Immediately available: after parking, leaseWait returns right away.
    hub.enqueue(keyA, job("a1"));
    expect((await hub.leaseWait(keyA, 1000))?.job.evalCase.id).toBe("a1");
    // When empty: leaseWait waits, is woken by enqueue, and takes that job.
    const waiting = hub.leaseWait(keyA, 1000);
    hub.enqueue(keyA, job("a2"));
    expect((await waiting)?.job.evalCase.id).toBe("a2");
  });

  it("leaseWait: null after waitMs if no job arrives", async () => {
    const hub = new RunnerHub();
    expect(await hub.leaseWait(keyA, 5)).toBeNull();
  });

  it("heartbeat renews the lease to prevent requeue", async () => {
    let t = 0;
    const hub = new RunnerHub({ newJobId: () => "j1", now: () => t, leaseTtlMs: 100 });
    hub.enqueue(keyA, job("c1"));
    hub.lease(keyA); // t=0
    t = 80;
    expect(hub.heartbeat(keyA, "j1").extended).toBe(true); // renew lease (leasedAt=80)
    t = 150; // expired against the first lease but not against the heartbeat (80) → not requeued
    expect(hub.lease(keyA)).toBeNull();
    expect(hub.heartbeat(keyA, "nope").extended).toBe(false); // unknown jobId
  });
});

// Workspace pool (self:ws) — several runners of the same owner drain one pool queue. runnerId=POOL_RUNNER("*").
describe("RunnerHub — workspace pool (N runners drain)", () => {
  const OWNER = "ws:acme";
  const r1: SelfHostedKey = { owner: OWNER, runnerId: "r1" };
  const r2: SelfHostedKey = { owner: OWNER, runnerId: "r2" };

  it("jobs put in the pool are split across that owner's runners, each completing with its own key", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const d1 = hub.enqueue(poolKeyFor(OWNER), job("p1")); // j-0
    const d2 = hub.enqueue(poolKeyFor(OWNER), job("p2")); // j-1
    expect(hub.lease(r1)?.job.evalCase.id).toBe("p1"); // r1 takes one from the pool
    expect(hub.lease(r2)?.job.evalCase.id).toBe("p2"); // r2 takes the next from the pool
    expect(hub.lease(r1)).toBeNull(); // pool drained
    // A pool job stays in the pool queue, but the runner completes with its own key → locate finds it in the pool queue.
    // ranBy = the actual completing runner (the real r1/r2, not the pool key "*") → provenance.runner is recorded correctly.
    expect(hub.complete(r1, "j-0", result)).toBe(true);
    await expect(d1).resolves.toEqual({ result, ranBy: "r1" });
    expect(hub.complete(r2, "j-1", result)).toBe(true);
    await expect(d2).resolves.toEqual({ result, ranBy: "r2" });
  });

  it("pool: capability mismatch is a skip, not a rejection — a runner without docker passes it by and a docker runner takes it", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    const d = hub.enqueue(poolKeyFor(OWNER), imageJob("needs-docker")); // requires docker
    expect(hub.lease({ owner: OWNER, runnerId: "no-docker" }, ["git"])).toBeNull(); // skipped (not rejected)
    // The job is still alive → the docker runner takes it.
    expect(hub.lease({ owner: OWNER, runnerId: "has-docker" }, ["git", "docker"])?.job.evalCase.id).toBe(
      "needs-docker",
    );
    expect(hub.complete({ owner: OWNER, runnerId: "has-docker" }, "j-img", result)).toBe(true);
    await expect(d).resolves.toMatchObject({ result });
  });

  // Regression (pool variant): a single pool runner draining the pool serially — the pool jobs queued behind the one it
  // is running must not expire; the runner's heartbeat (with its own key) proves the owner has a live runner for the pool.
  it("pool: jobs waiting behind a busy pool runner are kept alive by its heartbeat (serial drain doesn't spuriously reject)", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const hub = new RunnerHub({ queueTimeoutMs: 100, newJobId: () => `p-${n++}` });
      hub.enqueue(poolKeyFor(OWNER), job("p1")); // p-0 — leased & run first
      const d2 = hub.enqueue(poolKeyFor(OWNER), job("p2")); // p-1 — waits behind p1 in the pool
      let rejected = false;
      d2.catch(() => {
        rejected = true;
      });
      expect(hub.lease(r1)?.jobId).toBe("p-0"); // r1 takes p1 from the pool (serial)
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30);
        expect(hub.heartbeat(r1, "p-0").extended).toBe(true); // heartbeat on the running pool job (r1's own key)
      }
      expect(rejected).toBe(false); // p2 kept alive via the runner's proof-of-life across the owner pool
      hub.complete(r1, "p-0", result);
      expect(hub.lease(r1)?.jobId).toBe("p-1");
      hub.complete(r1, "p-1", result);
      await expect(d2).resolves.toMatchObject({ result });
    } finally {
      vi.useRealTimers();
    }
  });

  // Guard the proof-of-life refinement: only a heartbeat / a lease that TAKES a job refreshes the queue — an empty/skip
  // poll must NOT. Otherwise a job no connected runner can run (needs docker, only non-docker runners poll) would be kept
  // alive forever by their skip-polls and hang the batch instead of failing. It must still time out at ~queueTimeoutMs.
  it("pool: a job no connected runner can run still times out — an incapable runner's skip-polls don't keep it alive forever", async () => {
    vi.useFakeTimers();
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 100, newJobId: () => "j-img" });
      const d = hub.enqueue(poolKeyFor(OWNER), imageJob("needs-docker")); // requires docker
      let rejected = false;
      let reason: unknown;
      d.catch((e: unknown) => {
        rejected = true;
        reason = (e as { extra?: { reason?: string } }).extra?.reason;
      });
      // A non-docker runner keeps polling every 40ms (< the 100ms idle window) and skipping the docker job.
      for (let i = 0; i < 8; i++) {
        expect(hub.lease({ owner: OWNER, runnerId: "no-docker" }, ["git"])).toBeNull(); // skipped, not taken → no touch
        await vi.advanceTimersByTimeAsync(40);
      }
      expect(rejected).toBe(true); // fired at ~queueTimeoutMs despite continuous skip-polls (not kept alive indefinitely)
      expect(reason).toBe("no_runner");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pool: own-queue jobs are taken before pool jobs", () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    hub.enqueue(poolKeyFor(OWNER), job("pool-job")); // j-0
    hub.enqueue(r1, job("mine")); // j-1
    expect(hub.lease(r1)?.job.evalCase.id).toBe("mine"); // own queue first
    expect(hub.lease(r1)?.job.evalCase.id).toBe("pool-job"); // then the pool
  });

  it("pool: another owner's pool jobs are invisible (isolation)", () => {
    const hub = new RunnerHub({ newJobId: () => "j-x" });
    hub.enqueue(poolKeyFor("ws:beta"), job("beta-pool"));
    expect(hub.lease(r1)).toBeNull(); // an acme runner can't see the beta pool
  });

  it("pool: enqueue wakes that owner's long-poll-waiting runner", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-w" });
    const waiting = hub.leaseWait(r1, 1000); // r1 waits with its own key
    hub.enqueue(poolKeyFor(OWNER), job("pooled")); // pool enqueue → wakeOwner wakes r1
    expect((await waiting)?.job.evalCase.id).toBe("pooled");
    hub.complete(r1, "j-w", result);
  });

  it("pool wake fairness (round-robin): two runners waiting, two jobs → a different runner each (no single-runner monopoly)", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `w-${n++}` });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const seen: string[] = [];
    // Mini worker loop — wait, on receiving a job process it (complete) then re-wait; on null re-poll (same as a real worker). Up to 6 iterations.
    const worker = (runnerId: string) => async () => {
      for (let i = 0; i < 6 && seen.length < 2; i++) {
        const l = await hub.leaseWait({ owner: OWNER, runnerId }, 200);
        if (l) {
          seen.push(runnerId);
          hub.complete({ owner: OWNER, runnerId }, l.jobId, result);
        }
      }
    };
    const workers = Promise.all([worker("r1")(), worker("r2")()]);
    await sleep(15); // both park
    hub.enqueue(poolKeyFor(OWNER), job("p1")); // wake cursor=0 → r1 first → r1 processes then re-parks
    await sleep(15);
    hub.enqueue(poolKeyFor(OWNER), job("p2")); // wake cursor=1 → r2 first → r2 processes (rotation)
    await workers;
    expect([...seen].sort()).toEqual(["r1", "r2"]); // one each across the two runners (no monopoly)
  });
});

// Cancellation — a user stops a scorecard (or supersede reclaims it); the hub cancels that batch's in-flight jobs.
describe("RunnerHub — requestCancel (user stop / supersede)", () => {
  const withBatch = (id: string, batchId: string): AgentJob => ({ ...job(id), batchId });

  it("rejects a leased job's promise now and tells the runner to abort on its next heartbeat", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const dispatched = hub.enqueue(keyA, withBatch("c1", "sc-1"));
    const settled = dispatched.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    expect(hub.lease(keyA)?.jobId).toBe("j-0"); // runner took it (running)

    // A user stops scorecard sc-1 → cancel its in-flight jobs (keyed by batchId).
    expect(hub.requestCancel((j) => j.batchId === "sc-1")).toBe(1);

    // The dispatch promise is rejected NOW (the batch settles without waiting on the runner).
    const r = await settled;
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ e: { code: "UPSTREAM_ERROR", extra: { reason: "cancelled" } } });

    // The runner's next heartbeat is told to abort the local run (freeing the runtime mid-case).
    expect(hub.heartbeat(keyA, "j-0")).toMatchObject({ cancelled: true });
  });

  it("drops an un-leased (parked) cancelled job so a runner never picks it up", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-parked" });
    const dispatched = hub.enqueue(keyA, withBatch("c1", "sc-2"));
    dispatched.catch(() => {}); // rejected by cancel — prevent an unhandled rejection
    expect(hub.requestCancel((j) => j.batchId === "sc-2")).toBe(1);
    expect(hub.lease(keyA)).toBeNull(); // the cancelled parked job is never leased
  });

  it("returns 0 and no-ops when nothing matches the predicate", () => {
    const hub = new RunnerHub({ newJobId: () => "j" });
    hub.enqueue(keyA, withBatch("c1", "sc-3")).catch(() => {});
    expect(hub.requestCancel((j) => j.batchId === "other")).toBe(0);
  });
});
