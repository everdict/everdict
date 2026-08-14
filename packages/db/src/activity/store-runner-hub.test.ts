import { type SelfHostedKey, StoreRunnerHub } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryRunnerJobStore } from "./runner-job-store.js";

// StoreRunnerHub over the InMemory store — mirrors the Pg semantics, so these cover the multi-replica lease flow
// without a real database (the Pg impl is exercised by the env-gated *.scenario.test.ts).

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const job = (id: string): CaseJob => ({
  evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
});
const imageJob = (id: string): CaseJob => ({ ...job(id), evalCase: { ...job(id).evalCase, image: "sbench:v1" } });
const keyA: SelfHostedKey = { owner: "u-alice", runnerId: "laptop" };

let seq = 0;
const opts = (over: Record<string, unknown> = {}) => ({
  pollMs: 2,
  newJobId: () => `j-${seq++}`,
  queueTimeoutMs: 10_000,
  ...over,
});

describe("StoreRunnerHub — multi-replica lease over a shared store", () => {
  it("a job parked on replica A is leased + completed on replica B → A's dispatch resolves (cross-replica)", async () => {
    const store = new InMemoryRunnerJobStore();
    const replicaA = new StoreRunnerHub(store, opts());
    const replicaB = new StoreRunnerHub(store, opts());
    const dispatched = replicaA.enqueue(keyA, job("c1")); // parked on A, awaiting the result

    const leased = await replicaB.leaseWait(keyA, 200, ["repo"]); // B leases the SAME job from the shared store
    if (!leased) throw new Error("expected a lease");
    expect(leased.job.evalCase.id).toBe("c1");
    expect(await replicaB.complete(keyA, leased.attempt, result)).toBe(true); // B reports the result under its lease token

    await expect(dispatched).resolves.toMatchObject({ result, ranBy: "laptop" }); // A's promise resolves cross-replica
  });

  it("rejects as no_runner when no runner leases it within the idle timeout", async () => {
    const store = new InMemoryRunnerJobStore();
    const hub = new StoreRunnerHub(store, opts({ queueTimeoutMs: 15 }));
    await expect(hub.enqueue(keyA, job("c1"))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      extra: { reason: "no_runner" },
    });
  });

  it("a heartbeat keeps a leased job alive past the idle timeout (long-running case isn't rejected)", async () => {
    const store = new InMemoryRunnerJobStore();
    // Margins are deliberately wide (gap 30ms vs timeout 600ms, 20x): each heartbeat only has to land within one
    // timeout of the previous extension, and under a loaded parallel test run a timer can easily stretch several
    // fold — the old 10ms-vs-40ms ratio made this the suite's flake. The heartbeat span still totals ~750ms,
    // past the naked 600ms timeout, so the test keeps proving extension is what saves a long-running case.
    const hub = new StoreRunnerHub(store, opts({ queueTimeoutMs: 600 }));
    const d = hub.enqueue(keyA, job("c1"));
    const leased = await hub.leaseWait(keyA, 200, ["repo"]);
    if (!leased) throw new Error("expected a lease");
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 30));
      expect((await hub.heartbeat(keyA, leased.attempt)).extended).toBe(true);
    }
    expect(await hub.complete(keyA, leased.attempt, result)).toBe(true);
    await expect(d).resolves.toMatchObject({ result });
  });

  it("a stale holder's result, failure and heartbeat are refused after its lease was re-leased (epoch fence)", async () => {
    const store = new InMemoryRunnerJobStore();
    // leaseTtlMs 0 → the previous lease is already expired when the next claim runs (requeue-then-claim).
    const hub = new StoreRunnerHub(store, opts({ leaseTtlMs: 0 }));
    const d = hub.enqueue(keyA, job("c1"));
    d.catch(() => {}); // settled later by the successor — this test only watches the fence
    const first = await hub.leaseWait(keyA, 200, ["repo"]);
    if (!first) throw new Error("expected the first lease");
    const second = await hub.leaseWait(keyA, 200, ["repo"]); // requeues the expired lease, mints epoch+1
    if (!second) throw new Error("expected the re-lease");
    expect(second.attempt.leaseEpoch).toBe(first.attempt.leaseEpoch + 1);
    // The stale holder can neither end the successor's attempt nor keep it alive…
    expect(await hub.complete(keyA, first.attempt, result)).toBe(false);
    expect(await hub.fail(keyA, first.attempt, "late failure")).toBe(false);
    expect((await hub.heartbeat(keyA, first.attempt)).extended).toBe(false);
    // …and the successor's own token still works.
    expect((await hub.heartbeat(keyA, second.attempt)).extended).toBe(true);
    expect(await hub.complete(keyA, second.attempt, result)).toBe(true);
    await expect(d).resolves.toMatchObject({ result });
  });

  it("capability gate: an image job is not leased by a runner without docker (stays for a capable one)", async () => {
    const store = new InMemoryRunnerJobStore();
    const hub = new StoreRunnerHub(store, opts());
    hub.enqueue(keyA, imageJob("c-img")).catch(() => {});
    expect(await hub.leaseWait(keyA, 20, ["repo"])).toBeNull(); // no docker → can't claim
    const leased = await hub.leaseWait(keyA, 20, ["repo", "docker"]); // docker runner claims it
    if (!leased) throw new Error("expected a lease");
    expect(leased.job.evalCase.id).toBe("c-img");
  });

  it("requestCancel marks matching jobs so the dispatch rejects as cancelled", async () => {
    const store = new InMemoryRunnerJobStore();
    const hub = new StoreRunnerHub(store, opts());
    const d = hub.enqueue(keyA, job("c1"));
    const settled = d.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    expect(await hub.requestCancel((j) => j.evalCase.id === "c1")).toBe(1);
    const r = await settled;
    expect(r).toMatchObject({ ok: false, e: { code: "UPSTREAM_ERROR", extra: { reason: "cancelled" } } });
  });
});
