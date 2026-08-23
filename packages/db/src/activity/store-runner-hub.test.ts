import {
  InMemoryExecutionAttemptStore,
  type OpenLeaseAttempt,
  type SelfHostedKey,
  StoreRunnerHub,
} from "@everdict/application-control";
import { runExecutionId, storedExecutionId } from "@everdict/contracts";
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

  // The store twin of the in-memory hub's lease-time attempt mint (arch-review 41 P0-evidence). Here the
  // restamp has to be PERSISTED: `authorize` answers every pushed frame/log out of the row, so a generation
  // that lived only in the lease reply would leave the durable lane still naming the first attempt.
  it("a re-lease opens its own recording attempt and persists it — authorize stops serving the first attempt's generation", async () => {
    const store = new InMemoryRunnerJobStore();
    let opened = 20;
    // leaseTtlMs 0 → the first lease is already expired when the next claim runs (requeue-then-claim).
    const hub = new StoreRunnerHub(store, opts({ leaseTtlMs: 0, openAttempt: async () => ++opened }));
    const d = hub.enqueue(keyA, { ...job("c1"), runId: "evd-run-1", recordingGeneration: 7 });

    const first = await hub.leaseWait(keyA, 200, ["repo"]);
    expect(first?.job.recordingGeneration).toBe(7); // the first lease runs the attempt the dispatch opened
    const second = await hub.leaseWait(keyA, 200, ["repo"]);
    if (!second) throw new Error("expected the re-lease");
    expect(second.attempt.leaseEpoch).toBe(2);
    expect(second.job.recordingGeneration).toBe(21); // its OWN attempt, not the abandoned one's 7
    // The ROW carries it, which is the half that matters — that is what the evidence wire authorizes against.
    expect(await store.authorize(second.jobId, keyA.runnerId, 2)).toMatchObject({ recordingGeneration: 21 });

    expect(await hub.complete(keyA, second.attempt, result)).toBe(true);
    await expect(d).resolves.toMatchObject({ generation: 21 }); // …and the parking replica seals THAT attempt
  });

  it("a restamp the row REFUSED hands out no job — the runner never receives a lease the store will not authorize (arch-review 47 P1-1)", async () => {
    // The row moves while the mint's open is in flight (a cancel here; an expiry sweep or another claim are
    // the same shape). Pre-fix the boolean was ignored: the runner received the job, executed it, and every
    // authorize/complete under that lease was refused — duplicate compute reporting into a void.
    const store = new InMemoryRunnerJobStore();
    let opened = 30;
    const gate: Array<() => void> = [];
    const hub = new StoreRunnerHub(
      store,
      opts({
        leaseTtlMs: 0,
        openAttempt: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            // The FIRST open call is the re-lease's (epoch 1 never mints) — park it.
            if (calls === 1) await new Promise<void>((r) => gate.push(r));
            return ++opened;
          };
        })(),
      }),
    );
    hub.enqueue(keyA, { ...job("c1"), runId: "evd-run-1", recordingGeneration: 7 }).catch(() => {});
    await hub.leaseWait(keyA, 200, ["repo"]); // epoch 1
    const minting = hub.leaseWait(keyA, 200, ["repo"]); // epoch 2 — its open parks on the gate
    // Wait until the open is actually parked (the claim + mint run across microtasks).
    while (gate.length === 0) await new Promise((r) => setImmediate(r));
    await store.cancel((j) => j.runId === "evd-run-1"); // the row moves under the sleeping mint
    gate[0]?.();
    // The refused restamp yields NO job (the loop found the row cancelled and the wait ran out).
    expect(await minting).toBeNull();
  });

  it("a re-lease whose attempt cannot be opened persists a job with NO generation (fail-closed, never merged)", async () => {
    const store = new InMemoryRunnerJobStore();
    const hub = new StoreRunnerHub(
      store,
      opts({ leaseTtlMs: 0, openAttempt: () => Promise.reject(new Error("recording store unreachable")) }),
    );
    hub.enqueue(keyA, { ...job("c1"), runId: "evd-run-1", recordingGeneration: 7 }).catch(() => {});
    await hub.leaseWait(keyA, 200, ["repo"]);
    const second = await hub.leaseWait(keyA, 200, ["repo"]);
    if (!second) throw new Error("expected the re-lease");
    expect(second.job.recordingGeneration).toBeUndefined();
    const authorized = await store.authorize(second.jobId, keyA.runnerId, 2);
    expect(authorized?.recordingGeneration).toBeUndefined(); // the ROW lost it too — nothing durable to merge into
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

// ── CANCELLATION IS CAPABILITY REVOCATION, NOT A HINT (arch-review 46) ───────────────────────────────
//
// The store lane treated `cancel_requested` as a flag to READ on the heartbeat and nothing else: the claim
// did not filter it (so a cancelled job was handed straight back out), and complete/fail/authorize/restampJob
// did not check it (so the holder could land its result as canonical — and `outcome` reports a terminal row
// verbatim, which is how a stopped batch read back "completed" and the cancellation disappeared from the
// record). The in-memory RunnerHub had the CLAIM half of this guard from the start; these pin both halves on
// the store, which is the lane a multi-replica control plane actually runs on.
describe("RunnerJobStore — a cancelled job's lease authorizes nothing", () => {
  const park = async (store: InMemoryRunnerJobStore, jobId: string) =>
    store.park({ jobId, owner: keyA.owner, runnerId: keyA.runnerId, job: job("c1"), requiredCaps: [], now: 0 });
  const claim = (store: InMemoryRunnerJobStore, now: number, leaseTtlMs = 60_000) =>
    store.claim({ owner: keyA.owner, runnerId: keyA.runnerId, leaseTtlMs, now });

  it("is never claimable once cancelled — a queued one is passed over and an expired lease is not requeued", async () => {
    const store = new InMemoryRunnerJobStore();
    await park(store, "j-queued");
    expect(await store.cancel(() => true)).toBe(1);
    expect(await claim(store, 1_000)).toBeNull(); // parked + cancelled → a runner never picks it up

    // …and the same holds for one already in a runner's hands whose lease then expires: the requeue path must
    // not hand cancelled work back out under a fresh epoch — nor DISSOLVE the lease, because that lease is the
    // channel the abort is delivered on. A cancelled job swept back to 'queued' leaves its holder heartbeating
    // against a row that no longer recognizes it, so it is never told to stop and runs to the end.
    const store2 = new InMemoryRunnerJobStore();
    await park(store2, "j-leased");
    expect(await claim(store2, 0)).toMatchObject({ jobId: "j-leased", leaseEpoch: 1 });
    expect(await store2.cancel(() => true)).toBe(1);
    expect(await claim(store2, 10_000, 0)).toBeNull(); // TTL long past — still not re-leased
    expect(await store2.touch("j-leased", keyA.runnerId, 1, 10_000)).toEqual({ extended: false, cancelled: true });
  });

  it("a cancelled row reaches a PERSISTED terminal state — queued at once, leased via ack or TTL sweep — and pending excludes it (arch-review 47 P1-2)", async () => {
    // Pre-fix the flag was the whole record: a row sat `queued|leased, cancel_requested` forever — counted
    // as pending, accumulated in the queue, ended by nothing.
    const store = new InMemoryRunnerJobStore();
    await store.park({
      jobId: "j-q",
      owner: keyA.owner,
      runnerId: keyA.runnerId,
      job: job("c1"),
      requiredCaps: [],
      now: 0,
    });
    await store.cancel(() => true);
    expect((await store.outcome("j-q"))?.status).toBe("cancelled");
    expect(await store.pending(keyA.owner, keyA.runnerId)).toBe(0); // terminal, not pending

    // LEASED + runner ack (its refused report terminalizes the row on the spot)…
    const ackStore = new InMemoryRunnerJobStore();
    await ackStore.park({
      jobId: "j-ack",
      owner: keyA.owner,
      runnerId: keyA.runnerId,
      job: job("c1"),
      requiredCaps: [],
      now: 0,
    });
    const lease = await ackStore.claim({ owner: keyA.owner, runnerId: keyA.runnerId, leaseTtlMs: 60_000, now: 0 });
    if (!lease) throw new Error("expected a lease");
    await ackStore.cancel(() => true);
    expect(await ackStore.pending(keyA.owner, keyA.runnerId)).toBe(0); // cancelling ≠ pending
    expect(await ackStore.complete("j-ack", result, keyA.runnerId, lease.leaseEpoch)).toBe(false);
    expect((await ackStore.outcome("j-ack"))?.status).toBe("cancelled"); // the refused report WAS the ack

    // …and LEASED + silent runner: the claim-time TTL sweep terminalizes instead of leaving limbo.
    const sweepStore = new InMemoryRunnerJobStore();
    await sweepStore.park({
      jobId: "j-ttl",
      owner: keyA.owner,
      runnerId: keyA.runnerId,
      job: job("c1"),
      requiredCaps: [],
      now: 0,
    });
    const l2 = await sweepStore.claim({ owner: keyA.owner, runnerId: keyA.runnerId, leaseTtlMs: 100, now: 0 });
    if (!l2) throw new Error("expected a lease");
    await sweepStore.cancel(() => true);
    await sweepStore.claim({ owner: keyA.owner, runnerId: keyA.runnerId, leaseTtlMs: 100, now: 10_000 }); // sweep
    expect((await sweepStore.outcome("j-ttl"))?.status).toBe("cancelled");
    // …and the swept holder's late heartbeat still HEARS the abort (the reply is the channel).
    expect(await sweepStore.touch("j-ttl", keyA.runnerId, l2.leaseEpoch, 10_001)).toEqual({
      extended: false,
      cancelled: true,
    });
  });

  it("refuses the cancelled holder's authorize/restamp/complete/fail, so the record still reads cancelled", async () => {
    const store = new InMemoryRunnerJobStore();
    await park(store, "j1");
    const lease = await claim(store, 0);
    if (!lease) throw new Error("expected a lease");
    expect(await store.authorize("j1", keyA.runnerId, lease.leaseEpoch)).not.toBeNull(); // authorized while live
    expect(await store.cancel(() => true)).toBe(1);

    // The evidence surface closes with the result surface — one predicate, both wires.
    expect(await store.authorize("j1", keyA.runnerId, lease.leaseEpoch)).toBeNull();
    expect(await store.restampJob("j1", keyA.runnerId, lease.leaseEpoch, job("c1"))).toBe(false);
    expect(await store.fail("j1", "late failure", keyA.runnerId, lease.leaseEpoch)).toBe(false);
    expect(await store.complete("j1", result, keyA.runnerId, lease.leaseEpoch)).toBe(false);
    // The point of the whole guard: a landed complete() made `outcome` report "completed" and the user's stop
    // left no trace on the record at all.
    expect(await store.outcome("j1")).toMatchObject({ status: "cancelled" });
  });

  it("still tells a cancelled lease to stop on its heartbeat, but stops renewing it", async () => {
    const store = new InMemoryRunnerJobStore();
    await park(store, "j1");
    const lease = await claim(store, 0);
    if (!lease) throw new Error("expected a lease");
    expect(await store.touch("j1", keyA.runnerId, lease.leaseEpoch, 1_000)).toEqual({
      extended: true,
      cancelled: false,
    });
    expect(await store.cancel(() => true)).toBe(1);

    // Heard, not renewed: the reply is how the runner learns to abort, while the frozen activity clock means a
    // runner that ignores it ages out on the idle-timeout path instead of holding the job open forever.
    expect(await store.touch("j1", keyA.runnerId, lease.leaseEpoch, 9_000)).toEqual({
      extended: false,
      cancelled: true,
    });
    expect(await store.outcome("j1")).toMatchObject({ activityAt: 1_000 });
  });

  it("a cancelled in-flight job's late result cannot resurrect the dispatch as completed (through the hub)", async () => {
    const store = new InMemoryRunnerJobStore();
    const hub = new StoreRunnerHub(store, opts());
    const d = hub.enqueue(keyA, job("c1"));
    const settled = d.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const leased = await hub.leaseWait(keyA, 200, ["repo"]);
    if (!leased) throw new Error("expected a lease");
    expect(await hub.requestCancel((j) => j.evalCase.id === "c1")).toBe(1);
    expect(await settled).toMatchObject({ ok: false, e: { extra: { reason: "cancelled" } } });

    expect(await hub.complete(keyA, leased.attempt, result)).toBe(false); // the runner reports back anyway
    expect(await store.outcome(leased.jobId)).toMatchObject({ status: "cancelled" });
  });
});

// ── THE RE-LEASE'S ATTEMPT HAS A WHOLE LIFE, NOT JUST A NAME (arch-review 47 P1-3) ──────────────────
//
// The store twin of the in-memory hub's lifecycle tests. Same two halves: the attempt this claim opens is
// stamped `executing` with the lease epoch that authorized it, and an attempt whose restamp the row refused
// is ENDED instead of being left at `created` — pre-fix that row had no handle left to close it, because a
// number-only seam could only ever name what it opened.
//
// ⚠️ What this lane deliberately does NOT do is supersede the attempt the re-lease REPLACED: the prior
// attempt's id is not on the row and the previous claim may have been served by another replica entirely.
// That half needs the claim and the open to be one transaction (§5.1 claimAttempt).
describe("StoreRunnerHub — a re-lease completes the attempt lifecycle", () => {
  interface AttemptEvent {
    attemptId: string;
    kind: "executing" | "superseded";
    reason?: string;
    leaseEpoch?: number;
  }
  // The ledger-wired seam apps/api's composition root composes when an ExecutionAttemptStore is present.
  const attemptSeam = (
    over: { firstGeneration?: number; stall?: (call: number) => Promise<void> | undefined } = {},
  ) => {
    const calls: AttemptEvent[] = [];
    let call = 0;
    let generation = (over.firstGeneration ?? 21) - 1;
    return {
      calls,
      openAttempt: async (_job: CaseJob, lease?: { leaseEpoch: number }) => {
        call += 1;
        await over.stall?.(call);
        generation += 1;
        const attemptId = `evd-run-1#g${generation}`;
        return {
          generation,
          attemptId,
          supersede: async (reason: string) => {
            calls.push({ attemptId, kind: "superseded", reason });
          },
          markExecuting: async () => {
            calls.push({ attemptId, kind: "executing", ...(lease ? { leaseEpoch: lease.leaseEpoch } : {}) });
          },
        };
      },
    };
  };

  it("stamps the claimed attempt executing with the lease epoch that authorized it", async () => {
    const store = new InMemoryRunnerJobStore();
    const seam = attemptSeam({ firstGeneration: 21 });
    // leaseTtlMs 0 → the first lease is already expired when the next claim runs (requeue-then-claim).
    const hub = new StoreRunnerHub(store, opts({ leaseTtlMs: 0, openAttempt: seam.openAttempt }));
    hub.enqueue(keyA, { ...job("c1"), runId: "evd-run-1", recordingGeneration: 7 }).catch(() => {});

    await hub.leaseWait(keyA, 200, ["repo"]); // epoch 1 runs the dispatch's attempt — nothing is minted
    expect(seam.calls).toEqual([]);
    const second = await hub.leaseWait(keyA, 200, ["repo"]);
    expect(second?.job.recordingGeneration).toBe(21);
    expect(seam.calls).toEqual([{ attemptId: "evd-run-1#g21", kind: "executing", leaseEpoch: 2 }]);
  });

  it("a restamp the row REFUSED supersedes the attempt it just opened — no `created` orphan is left behind", async () => {
    const store = new InMemoryRunnerJobStore();
    const gate: Array<() => void> = [];
    const seam = attemptSeam({
      firstGeneration: 31,
      // The FIRST open call is the re-lease's (epoch 1 never mints) — park it so the row can move under it.
      stall: (call) => (call === 1 ? new Promise<void>((r) => gate.push(r)) : undefined),
    });
    const hub = new StoreRunnerHub(store, opts({ leaseTtlMs: 0, openAttempt: seam.openAttempt }));
    hub.enqueue(keyA, { ...job("c1"), runId: "evd-run-1", recordingGeneration: 7 }).catch(() => {});
    await hub.leaseWait(keyA, 200, ["repo"]); // epoch 1
    const minting = hub.leaseWait(keyA, 200, ["repo"]); // epoch 2 — its open parks on the gate
    while (gate.length === 0) await new Promise((r) => setImmediate(r));
    await store.cancel((j) => j.runId === "evd-run-1"); // the row moves under the sleeping mint
    gate[0]?.();

    expect(await minting).toBeNull(); // the refused restamp still hands out no job (arch-review 47 P1-1)
    // …and the row that lost claim opened reaches a terminal state: no execution will ever happen under it,
    // and after the restamp was refused nobody but this mint still held its handle.
    expect(seam.calls).toEqual([{ attemptId: "evd-run-1#g31", kind: "superseded", reason: "lease lost during mint" }]);
  });
});

// ── ONE TRANSITION MINTS A COMPLETE ATTEMPT (arch-review 47 §5.1) ───────────────────────────────────
//
// The claim, the predecessor's supersede and the successor's insert as ONE decision (RunnerJobStore.
// claimAttempt). What the three-step path structurally could not do is the first half: the replaced attempt's
// id was on no row, so it stood `executing` for ever while its successor ran and committed — the ledger
// reporting two live executions of a job that had one. The id now travels on the row (mig 0183), which is
// what lets ANY replica end the attempt it replaced.
describe("StoreRunnerHub — a claim mints its attempt inside the claim", () => {
  // The composition root's claim-lane seam, in miniature: supersede what the row names, open the successor,
  // stamp it executing under the epoch that authorized it — all through the ledger the STORE handed in.
  const seam = (ledger: InMemoryExecutionAttemptStore) => {
    const priors: Array<string | undefined> = [];
    const openLeaseAttempt: OpenLeaseAttempt = async ({ job, leaseEpoch, attempts, prior }) => {
      const store = attempts ?? ledger;
      priors.push(prior);
      if (prior !== undefined)
        await store.transition(prior, "superseded", {
          error: { code: "LEASE_SUPERSEDED", message: "re-leased to another runner" },
        });
      const { runId, tenant } = job;
      if (runId === undefined || tenant === undefined) throw new Error("the fixture job carries both");
      const opened = await store.open({ executionId: storedExecutionId(runId), tenant });
      return {
        generation: opened.generation,
        attemptId: opened.attemptId,
        markExecuting: async () => {
          await store.transition(opened.attemptId, "executing", { leaseEpoch });
        },
      };
    };
    return { priors, openLeaseAttempt };
  };
  const leasedJob = { ...job("c1"), runId: "evd-run-1", recordingGeneration: 7 };

  it("supersedes the attempt the row names and leaves exactly one live attempt behind (the cross-replica half)", async () => {
    const store = new InMemoryRunnerJobStore();
    const ledger = new InMemoryExecutionAttemptStore();
    const { priors, openLeaseAttempt } = seam(ledger);
    // leaseTtlMs 0 → each claim requeues the previous lease first, so these are genuine RE-leases.
    const hub = new StoreRunnerHub(store, opts({ leaseTtlMs: 0, openLeaseAttempt }));
    hub.enqueue(keyA, leasedJob).catch(() => {});

    const first = await hub.leaseWait(keyA, 200, ["repo"]);
    expect(first?.job.recordingGeneration).toBe(7); // the first lease runs the attempt the DISPATCH opened
    expect(await ledger.list(runExecutionId("1"))).toEqual([]); // …so the lease lane mints nothing at all
    const second = await hub.leaseWait(keyA, 200, ["repo"]);
    expect(second?.job.recordingGeneration).toBe(1); // its OWN attempt, minted by the ledger
    const third = await hub.leaseWait(keyA, 200, ["repo"]);
    expect(third?.job.recordingGeneration).toBe(2);

    // The row told the third claim what the second one opened — the id no replica-local handle could carry.
    expect(priors).toEqual([undefined, "evd-run-1#g1"]);
    expect((await ledger.list(runExecutionId("1"))).map((a) => [a.attemptId, a.state, a.leaseEpoch])).toEqual([
      ["evd-run-1#g1", "superseded", 2], // ended by the claim that replaced it, not left `executing` for ever
      ["evd-run-1#g2", "executing", 3], // …under the lease epoch that authorized it
    ]);
  });

  // ── THE FIRST ATTEMPT IS ON THE ROW FROM PARK (arch-review 51) ─────────────────────────────────────
  //
  // `current_attempt_id` was written only by a re-lease's mint, so the FIRST re-lease read no predecessor:
  // the attempt the DISPATCH opened — the one actually running when the job was requeued — was superseded by
  // nobody and stood `executing` for ever beside its successor's `committed`. The dispatch's attempt reaches
  // this replica the only way it can, on the job, and the park puts it on the row.
  it("supersedes the DISPATCH's own attempt on the first re-lease, because park wrote it to the row", async () => {
    const store = new InMemoryRunnerJobStore();
    const ledger = new InMemoryExecutionAttemptStore();
    // The attempt the dispatch opened before the job was ever parked, executing on the runner that went silent.
    const dispatched = await ledger.open({ executionId: runExecutionId("1"), tenant: "acme" });
    await ledger.transition(dispatched.attemptId, "executing");
    const { priors, openLeaseAttempt } = seam(ledger);
    const hub = new StoreRunnerHub(store, opts({ leaseTtlMs: 0, openLeaseAttempt }));
    hub
      .enqueue(keyA, {
        ...job("c1"),
        runId: "evd-run-1",
        recordingGeneration: dispatched.generation,
        attemptId: dispatched.attemptId,
      })
      .catch(() => {});

    await hub.leaseWait(keyA, 200, ["repo"]); // epoch 1 — runs the dispatch's attempt, mints nothing
    const second = await hub.leaseWait(keyA, 200, ["repo"]); // epoch 2 — a second physical execution

    // The claim was told what the PARK recorded, not merely what a previous mint left behind.
    expect(priors).toEqual([dispatched.attemptId]);
    expect((await ledger.list(runExecutionId("1"))).map((a) => [a.attemptId, a.state])).toEqual([
      ["evd-run-1#g1", "superseded"], // the dispatch's attempt, ended by the lease that replaced it
      ["evd-run-1#g2", "executing"],
    ]);
    // …and the re-leased job names its OWN attempt: the name and the generation are one coordinate, so
    // leaving the replaced attempt's name on the job would have every later read address the abandoned row.
    expect(second?.job.attemptId).toBe("evd-run-1#g2");
    expect(second?.job.recordingGeneration).toBe(2);
  });

  it("a mint that throws rolls the claim back — the job is still claimable and no lease was handed out", async () => {
    const store = new InMemoryRunnerJobStore();
    const ledger = new InMemoryExecutionAttemptStore();
    let fail = true;
    const openLeaseAttempt: OpenLeaseAttempt = async ({ job, leaseEpoch, attempts, prior }) => {
      if (fail) throw new Error("attempt ledger unreachable");
      return seam(ledger).openLeaseAttempt({
        job,
        leaseEpoch,
        ...(attempts ? { attempts } : {}),
        ...(prior !== undefined ? { prior } : {}),
      });
    };
    const hub = new StoreRunnerHub(store, opts({ leaseTtlMs: 0, openLeaseAttempt }));
    hub.enqueue(keyA, leasedJob).catch(() => {});
    const first = await hub.leaseWait(keyA, 200, ["repo"]); // epoch 1 mints nothing — it cannot fail
    if (!first) throw new Error("expected the first lease");

    // The re-lease's mint fails: "this runner holds a lease" and "the ledger could not record its attempt"
    // must not both be true, so the claim itself is undone.
    await expect(hub.leaseWait(keyA, 50, ["repo"])).rejects.toThrow("attempt ledger unreachable");
    // The row is back in the QUEUE, not sitting `leased` under an epoch nobody holds — which is the half a
    // rollback-less claim gets wrong: the epoch it minted would go on authorizing evidence for a lease that
    // was never handed out, and only the idle-timeout sweep would ever free the job.
    expect(await store.outcome(first.jobId)).toMatchObject({ status: "queued" });
    expect(await store.authorize(first.jobId, keyA.runnerId, 2)).toBeNull();
    fail = false;
    const recovered = await hub.leaseWait(keyA, 200, ["repo"]); // the job never left the queue
    expect(recovered?.job.recordingGeneration).toBe(1);
  });

  it("keeps the three-step path when no claim-lane seam is wired — an unwired deployment is byte-for-byte unchanged", async () => {
    const store = new InMemoryRunnerJobStore();
    let claims = 0;
    const wrapped = Object.assign(
      Object.create(Object.getPrototypeOf(store) as object) as InMemoryRunnerJobStore,
      store,
      {
        claimAttempt: async (...args: Parameters<NonNullable<typeof store.claimAttempt>>) => {
          claims += 1;
          return store.claimAttempt(...args);
        },
      },
    );
    let opened = 40;
    // Only the legacy per-lease seam is wired (openAttempt), which is what a composition with no
    // transaction-capable store hands over.
    const hub = new StoreRunnerHub(wrapped, opts({ leaseTtlMs: 0, openAttempt: async () => ++opened }));
    hub.enqueue(keyA, leasedJob).catch(() => {});
    await hub.leaseWait(keyA, 200, ["repo"]);
    const second = await hub.leaseWait(keyA, 200, ["repo"]);
    expect(second?.job.recordingGeneration).toBe(41); // claim → open → restampJob, exactly as before
    expect(claims).toBe(0); // …and the transactional entry point was never taken
  });
});
