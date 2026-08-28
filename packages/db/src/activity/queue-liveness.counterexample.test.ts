import { StoreRunnerHub } from "@everdict/application-control";
import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryRunnerJobStore } from "./runner-job-store.js";

// ── [R119 COUNTEREXAMPLE] A RUNNER'S LIVENESS KEEPS ITS QUEUE ALIVE ─────────────────────────────────
//
// The store lane enforces the idle timeout per job, off that row's `activity_at`, and only two statements
// ever wrote it: the CLAIM of that job and the HEARTBEAT of that job. Nothing refreshed a job still QUEUED.
//
// So a self-hosted job queued behind a long-running one aged out after `queueTimeoutMs` and was rejected
//
//     "No self-hosted runner activity — the runner is not connected, is idle/dead, …"
//
// while its runner was connected, capable, and busy with the job ahead of it. The in-memory hub has always
// had the mechanism (`touchByRunner` → `rearmWaiting`, whose comment names this exact case: "a
// maxConcurrent=1 runner heartbeats only the job it is running; the jobs queued behind it must not expire
// meanwhile"), and the store lane took the argument as `_capabilities` under a comment about per-process
// timers — while its own class header claimed the behaviour: "connected-but-busy runners keep it fresh via
// their heartbeat, exactly like the in-memory hub".
//
// Comment-is-a-claim, with the promised component being an UPDATE statement that did not exist.
//
// Seen RED before the fix:
//   "a busy runner's heartbeat did not keep the job queued behind it alive: expected 1000 to be 9000"
//   "the runner's own claim did not refresh the queue behind it: expected 1000 to be 5000"
// and the capability case failed the other way — every queued job was refreshed regardless of caps once
// `touchWaiting` existed but was not scoped.

const OWNER = "acme:runner-pool";
const RUNNER = "runner-1";

const job = (id: string, caps: string[] = []): CaseJob =>
  ({
    caseId: id,
    tenant: "acme",
    // `requiredRunnerCapabilities` reads the job's harness/env; a declared `runnerCapabilities` is the
    // explicit spelling the store parks as `required_caps`.
    ...(caps.length > 0 ? { runnerCapabilities: caps } : {}),
  }) as unknown as CaseJob;

// A hub whose clock the test moves. `enqueue` parks and then polls, so nothing here awaits its promise —
// what is under test is the ACTIVITY CLOCK the polling reads, not the poll.
function harness(now: () => number) {
  const store = new InMemoryRunnerJobStore();
  const hub = new StoreRunnerHub(store, { now, queueTimeoutMs: 5_000, leaseTtlMs: 120_000, pollMs: 1 });
  return { store, hub };
}

describe("[R119 COUNTEREXAMPLE] the store lane keeps a busy runner's queued jobs alive", () => {
  it("a HEARTBEAT on one job refreshes the jobs queued behind it", async () => {
    let clock = 1_000;
    const { store, hub } = harness(() => clock);
    await store.park({ jobId: "A", owner: OWNER, runnerId: RUNNER, job: job("a"), requiredCaps: [], now: clock });
    await store.park({ jobId: "B", owner: OWNER, runnerId: RUNNER, job: job("b"), requiredCaps: [], now: clock });

    const lease = await store.claim({ owner: OWNER, runnerId: RUNNER, leaseTtlMs: 120_000, now: clock });
    expect(lease?.jobId, "the claim did not take the first queued job").toBe("A");

    // …time passes past the idle timeout while the runner works on A and heartbeats it.
    clock = 9_000;
    const beat = await hub.heartbeat(
      { owner: OWNER, runnerId: RUNNER },
      { jobId: "A", leaseEpoch: lease?.leaseEpoch ?? 0 },
      [],
    );

    expect(beat.extended, "the holder's own lease stopped being extended").toBe(true);
    const b = await store.outcome("B");
    expect(b?.status).toBe("queued");
    expect(b?.activityAt, "a busy runner's heartbeat did not keep the job queued behind it alive").toBe(9_000);
  });

  it("a CLAIM refreshes the queue behind it too — taking a job is liveness as much as a heartbeat is", async () => {
    let clock = 1_000;
    const { store, hub } = harness(() => clock);
    await store.park({ jobId: "A", owner: OWNER, runnerId: RUNNER, job: job("a"), requiredCaps: [], now: clock });
    await store.park({ jobId: "B", owner: OWNER, runnerId: RUNNER, job: job("b"), requiredCaps: [], now: clock });

    clock = 5_000;
    await hub.leaseWait({ owner: OWNER, runnerId: RUNNER }, 0, []);

    expect((await store.outcome("B"))?.activityAt, "the runner's own claim did not refresh the queue behind it").toBe(
      5_000,
    );
  });

  it("refreshes ONLY what this runner could take — an incapable runner may not keep a job pending for ever", async () => {
    // The half that is not merely liveness: if a surviving-but-incapable runner refreshed everything, a job
    // whose only capable runner DIED would pend for ever instead of failing with a reason.
    let clock = 1_000;
    const { store } = harness(() => clock);
    await store.park({ jobId: "PLAIN", owner: OWNER, runnerId: RUNNER, job: job("p"), requiredCaps: [], now: clock });
    await store.park({
      jobId: "GPU",
      owner: OWNER,
      runnerId: RUNNER,
      job: job("g", ["gpu"]),
      requiredCaps: ["gpu"],
      now: clock,
    });

    clock = 9_000;
    const refreshed = await store.touchWaiting({ owner: OWNER, runnerId: RUNNER, advertisedCaps: [], now: clock });

    expect(refreshed, "the refresh was not scoped to what the runner advertises").toBe(1);
    expect((await store.outcome("PLAIN"))?.activityAt).toBe(9_000);
    expect((await store.outcome("GPU"))?.activityAt, "an incapable runner kept a job alive it could never claim").toBe(
      1_000,
    );
  });

  it("leaves cancelled and already-leased rows alone", async () => {
    let clock = 1_000;
    const { store } = harness(() => clock);
    await store.park({ jobId: "A", owner: OWNER, runnerId: RUNNER, job: job("a"), requiredCaps: [], now: clock });
    await store.park({ jobId: "C", owner: OWNER, runnerId: RUNNER, job: job("c"), requiredCaps: [], now: clock });
    await store.claim({ owner: OWNER, runnerId: RUNNER, leaseTtlMs: 120_000, now: clock }); // A → leased
    await store.cancel((j) => (j as { caseId?: string }).caseId === "c");

    clock = 9_000;
    const refreshed = await store.touchWaiting({ owner: OWNER, runnerId: RUNNER, now: clock });

    expect(refreshed, "a leased or cancelled row was refreshed as though it were waiting").toBe(0);
  });
});
