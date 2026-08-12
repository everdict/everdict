import {
  type DriverAuthority,
  type ReplicaRegistry,
  ScorecardService,
  recoverInterrupted,
} from "@everdict/application-control";
import type { CaseJob, CaseResult, RunRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";

// A registry that answers "who is alive"; heartbeat/leave are the process lifecycle, not this scenario's.
const aliveOnly = (who: string[]): ReplicaRegistry => ({
  liveReplicas: async () => who,
  beat: async () => {},
  leave: async () => {},
});

// Trust suite (docs/trust-certification.md) — TRUST-147.
//
// WON AUTHORITY IS NOT RE-READ AUTHORITY.
//
// A fencing token is a capability handed over by the claim that won it. The moment a driver can obtain the
// same token by READING the row, the token stops fencing anything — and no race is needed to take it, only a
// pause and a query. Three replicas are the smallest arrangement that shows it, and it is an ordinary one:
//
//   B claims the batch (epoch 1) and then pauses — a long GC, a partition, a slow adopt.
//   C declares B dead, claims it (epoch 2), and starts driving.
//   B wakes and resumes.
//
// If B derives its authority from the record, it reads 2 — C's token — and drives beside C holding a number
// that satisfies every guard C's writes satisfy. Both dispatch, both settle, and the fence that was supposed
// to make takeover observable to the loser has told it nothing.
//
// What is certified here is that B, holding the epoch it actually won, dispatches nothing and settles
// nothing: not the row, not a child, not a tombstone. The batch belongs to C.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const CASES = ["c1", "c2", "c3"];

const result = (caseId: string): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  scores: [{ metric: "pass", graderId: "g", value: 1 }],
  snapshot: { kind: "prompt", output: "" },
});

async function build(dispatch: (job: CaseJob) => Promise<CaseResult>) {
  const datasets = new InMemoryDatasetRegistry();
  await datasets.register("acme", {
    id: "three",
    version: "1.0.0",
    tags: [],
    cases: CASES.map((id) => ({
      id,
      env: { kind: "prompt" as const },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
  });
  const harnesses = new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry());
  const store = new InMemoryScorecardStore();
  const runStore = new InMemoryRunStore();
  const service = new ScorecardService({ dispatcher: { dispatch }, store, runStore, datasets, harnesses });
  return { service, store, runStore };
}

describeTrust("TRUST-147 — a fencing token is carried from the claim, never read back off the row", () => {
  it("a twice-taken-over batch is driven by its newest owner alone", async () => {
    const dispatched: string[] = [];
    const { service, store } = await build(async (job) => {
      dispatched.push(job.evalCase.id);
      return result(job.evalCase.id);
    });

    // An interrupted batch, owned by a replica that is now gone.
    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "three", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 200));
    await store.update(record.id, { status: "running", ownerReplica: "cp-a" });
    dispatched.length = 0;

    // ── B's recovery claims it, and B is handed the epoch it won.
    let carried: DriverAuthority | undefined;
    await recoverInterrupted({
      scorecards: store,
      owner: "cp-b",
      replicas: aliveOnly(["cp-b"]),
      resume: async (_id, authority) => {
        carried = authority;
        return true; // B claims, then pauses here — it has not driven anything yet
      },
    });
    expect(carried?.epoch).toBe(1);

    // ── C declares B dead and takes the batch. Nothing is sent to B; that is the entire situation.
    await recoverInterrupted({
      scorecards: store,
      owner: "cp-c",
      replicas: aliveOnly(["cp-c"]),
      resume: async () => true,
    });
    expect((await store.get(record.id))?.ownerEpoch).toBe(2);
    expect((await store.get(record.id))?.ownerReplica).toBe("cp-c");

    // ── B finally wakes and resumes, holding the token it won and NOT the one now on the row.
    const resumed = await service.resume(record.id, carried ?? { ownerReplica: "cp-b", epoch: 1 });
    await new Promise((r) => setTimeout(r, 400));

    // B dispatched nothing. Pre-fix it re-read the record, adopted C's epoch as its own, and ran the batch.
    expect(dispatched).toEqual([]);
    // …and it settled nothing either: the batch is still C's to finish.
    const after = await store.get(record.id);
    expect(after?.status).toBe("running");
    expect(after?.ownerReplica).toBe("cp-c");
    expect(resumed).toBe(true); // the resume path ran; it simply had no authority to act
  }, 20_000);

  it("a displaced recovery cannot tombstone the open run its successor is driving", async () => {
    // The same rule on the standalone-run leg, where the tombstone is the dangerous write: `expectNonTerminal`
    // says the run is open, which is exactly what makes it the successor's to finish.
    const runStore = new InMemoryRunStore();
    const record: RunRecord = {
      id: "run-carried",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "running",
      ownerReplica: "cp-a",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    await runStore.create(record);

    let bAuthority: DriverAuthority | undefined;
    await recoverInterrupted({
      scorecards: new InMemoryScorecardStore(),
      runs: runStore,
      owner: "cp-b",
      replicas: aliveOnly(["cp-b"]),
      resumeRun: async (_r, authority) => {
        bAuthority = authority;
        return true; // B claims and pauses
      },
    });
    expect(bAuthority?.epoch).toBe(1);

    // C takes it over.
    await recoverInterrupted({
      scorecards: new InMemoryScorecardStore(),
      runs: runStore,
      owner: "cp-c",
      replicas: aliveOnly(["cp-c"]),
      resumeRun: async () => true,
    });
    expect((await runStore.get("run-carried"))?.ownerEpoch).toBe(2);

    // B wakes, cannot resume, and tries to tombstone under the epoch it holds — which is no longer the row's.
    const tombstone = await runStore.update(
      "run-carried",
      { status: "failed", error: { code: "INTERRUPTED", message: "b gave up" }, updatedAt: "2026-08-12T00:01:00Z" },
      undefined,
      { expectNonTerminal: true, expectOwnerEpoch: bAuthority?.epoch ?? 0 },
    );
    expect(tombstone).toBeUndefined();
    expect((await runStore.get("run-carried"))?.status).toBe("running");
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-148.
//
// SETTLEMENT AUTHORITY GOVERNS EVIDENCE PUBLICATION.
//
// The row is not the only artifact a run produces. The OWNED trajectory is the copy every later judgment
// stands on, and the trajectory store keeps the FIRST seal for an emitter on purpose — immutable evidence, so
// a retried settle can never rewrite what was recorded. Put those two facts together with a displaced driver
// and they produce something worse than either: A loses the terminal CAS, seals anyway because sealing was
// never conditioned on winning, and B — which DID win — finds its own seal refused as a re-offer. The run
// then reads `result = B, trajectory = A`. One record, two executions, and nothing on it saying so.
//
// The fix is an ordering: settle first, publish from the answer. What is asserted is the absence — the
// displaced driver's trace is nowhere in the store, so the winner's is the only evidence there is.
describeTrust("TRUST-148 — a settlement that lost publishes no evidence", () => {
  it("a displaced driver seals no trajectory, so the winner's is the one the run keeps", async () => {
    const { InMemoryTrajectoryStore } = await import("@everdict/db");
    const { RunService } = await import("@everdict/application-control");
    const trajectories = new InMemoryTrajectoryStore();
    const store = new InMemoryRunStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const service = new RunService({
      store,
      trajectories,
      dispatcher: {
        async dispatch(job: CaseJob) {
          await gate; // A is in flight for as long as this scenario needs it to be
          return {
            ...result(job.evalCase.id),
            trace: [{ kind: "message", t: 0, role: "assistant", text: "A's execution" }],
          };
        },
      },
    } as never);

    const record = await service.submit({
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    } as never);
    await new Promise((r) => setTimeout(r, 50));

    // Another replica declares this driver dead and claims the run: the epoch moves under A.
    const claimed = await store.update(record.id, { ownerReplica: "cp-b" }, undefined, {
      expectNonTerminal: true,
      claimOwnership: true,
    });
    expect(claimed?.ownerEpoch).toBe(1);

    release();
    await new Promise((r) => setTimeout(r, 300));

    // A's settle was refused — it holds epoch 0 — so the row is still OPEN for its new owner.
    const row = await store.get(record.id);
    expect(["queued", "running"]).toContain(row?.status);
    expect(row?.result).toBeUndefined();
    // …and it published NO evidence. Pre-fix the seal ran regardless, and because the first seal wins it
    // would have been the permanent trajectory of a run whose outcome somebody else decides.
    expect(await trajectories.get("acme", record.id)).toBeUndefined();
  }, 20_000);
});
