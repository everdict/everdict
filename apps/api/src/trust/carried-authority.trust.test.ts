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
  InMemoryJudgeRegistry,
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

// Trust suite (docs/trust-certification.md) — TRUST-149.
//
// A TERMINAL CHILD IS FINALIZED EVIDENCE, NOT A FINISHED EXECUTION.
//
// Recovery's seed rule is a sentence about meaning: a terminal child that carries a result is finished work,
// so do not re-run it and do not re-judge it. The in-process batch driver made that sentence false. It
// settled the child `succeeded` the moment the harness returned, with the RAW execution result, and ran the
// selected judges afterwards on the streaming path. Crash in between — a deploy, an OOM, a lost node — and
// what survives is a row that satisfies the rule while carrying evidence no judge ever saw. The batch then
// completes with a case that silently never met a judge its own manifest says was selected: no score, and no
// `unmeasured` row explaining the absence. That is a wrong VERDICT produced without one failed write.
//
// The Temporal driver already awaited its judges before settling, so the SAME recovery rule was reading two
// different meanings depending on which driver a deployment happened to run. What is certified here is the
// invariant itself, on the in-process path: while a judge is still out, the child is not terminal.
describeTrust("TRUST-149 — a child is terminal only once its judges have landed", () => {
  it("an unfinished judge keeps the child open, and settles it with the judged result", async () => {
    let releaseJudge!: () => void;
    const judging = new Promise<void>((r) => {
      releaseJudge = r;
    });
    let judgeStarted!: () => void;
    const started = new Promise<void>((r) => {
      judgeStarted = r;
    });

    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "one",
      version: "1.0.0",
      tags: [],
      cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
    });
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    });
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const service = new ScorecardService({
      dispatcher: { dispatch: async (job: CaseJob) => result(job.evalCase.id) },
      store,
      runStore,
      datasets,
      judges,
      // The judge that has not answered yet — the whole window this scenario is about.
      judgeRunner: {
        run: async () => {
          judgeStarted();
          await judging;
          return [{ graderId: "quality", metric: "judge:quality", value: 1 }];
        },
      },
    } as never);

    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "one", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      judges: [{ id: "quality", version: "1.0.0" }],
    } as never);

    await started; // the harness has returned and the judge is in flight
    await new Promise((r) => setTimeout(r, 50));

    // THE CLAIM. The execution finished; the evidence has not. A crash here must leave recovery something it
    // reads as unfinished — so the child is still open, and pre-fix it was `succeeded` with a judge-less result.
    const children = await runStore.list("acme", { scorecardId: record.id });
    expect(children).toHaveLength(1);
    expect(children[0]?.status).not.toBe("succeeded");

    releaseJudge();
    await new Promise((r) => setTimeout(r, 400));

    // …and once the judge lands, the child settles ONCE, carrying the judged result.
    const settled = (await runStore.list("acme", { scorecardId: record.id }))[0];
    expect(settled?.status).toBe("succeeded");
    expect(settled?.result?.scores.some((s) => s.metric === "judge:quality")).toBe(true);
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-150.
//
// PARENT AUTHORITY CARRIED IS NOT CHILD MUTATION AUTHORIZED.
//
// A batch's children have fencing tokens of their own, and a parent takeover does not move them: claiming the
// SCORECARD raises the scorecard's epoch and leaves every child exactly where it was. So the child fence — the
// one added when this rule was first noticed — answers "did somebody take over this run" and never "am I
// still this batch's driver". A displaced replica clears it every time.
//
// It matters because `resume` touches children BEFORE it proves anything: it lists them, adopts the ones with
// harvestable results, and tombstones the rest, all ahead of the `track` call where the parent epoch is
// finally checked. A replica that lost the batch while paused therefore discovers it has no authority AFTER
// it has already rewritten its successor's children.
//
// The condition is evaluated inside the child's write, against the parent row, the same way the scoring fence
// is — a read-then-write would leave a window the shape of the takeover it exists to catch.
describeTrust("TRUST-150 — a displaced batch driver cannot mutate its successor's children", () => {
  it("the child write is refused because the PARENT's epoch moved, not the child's", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    runs.attachScorecards(scorecards);
    await scorecards.create({
      id: "sc-parent",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      status: "running",
      ownerReplica: "cp-b",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    } as never);
    await runs.create({
      id: "child-1",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c1",
      status: "running",
      parentScorecardId: "sc-parent",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    } as never);

    // B holds the batch at epoch 0 and pauses. C takes it: the PARENT's token moves to 1…
    const claimed = await scorecards.update("sc-parent", { ownerReplica: "cp-c" }, undefined, {
      expectNonTerminal: true,
      claimOwnership: true,
    });
    expect(claimed?.ownerEpoch).toBe(1);
    // …and the child's does NOT. This is the whole point: every child-level condition still holds for B.
    expect((await runs.get("child-1"))?.ownerEpoch ?? 0).toBe(0);

    // B wakes and tombstones the child it believes is its to clean up. Open row, matching child epoch —
    // and refused anyway, because the batch it was acting for is no longer its own.
    const stale = await runs.update(
      "child-1",
      { status: "failed", error: { code: "INTERRUPTED", message: "b cleaning up" }, updatedAt: "2026-08-12T01:00:00Z" },
      undefined,
      { expectNonTerminal: true, expectOwnerEpoch: 0, parentDriver: { scorecardId: "sc-parent", epoch: 0 } },
    );
    expect(stale).toBeUndefined();
    expect((await runs.get("child-1"))?.status).toBe("running");

    // …and C, holding the batch, settles the same child normally.
    const settled = await runs.update(
      "child-1",
      { status: "succeeded", updatedAt: "2026-08-12T01:00:01Z" },
      undefined,
      { expectNonTerminal: true, expectOwnerEpoch: 0, parentDriver: { scorecardId: "sc-parent", epoch: 1 } },
    );
    expect(settled?.status).toBe("succeeded");
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-151.
//
// A REPLAY IS THE EXECUTION THE RUN KEPT, NOT EVERY EXECUTION THAT CARRIED ITS ID.
//
// The seal is winner-gated; the BUFFER is not, and cannot easily be. Frames, logs and resource samples are
// appended while the run executes under its live-correlation id — derived from the record so an observer needs
// no lookup, which is the property that makes live observation work at all — and a re-driven run keeps that
// same id. Two attempts therefore append into one buffer, and the winner used to seal a replay containing an
// execution whose settlement was REFUSED: a reader scrubbing that timeline watches two runs with nothing
// saying where the seam is.
//
// The boundary is drawn where an attempt BEGINS, by the driver that won the right to begin it, rather than by
// filtering at seal time — the lanes do not share a clock (frames and logs are wall-clock, folded env deltas
// are trace-relative offsets), so "older than this attempt" is not a question the entries can all answer.
// "Start again" is. That distinction is not academic: the first draft of this fix filtered by time and
// silently dropped every folded env delta, which the ordinary recording tests caught.
describeTrust("TRUST-151 — a re-driven run's replay is its own attempt, not the one before it", () => {
  it("the winning re-drive clears the previous attempt's buffer before it executes", async () => {
    const { InMemoryRecordingStore, InMemoryRunStore: Runs } = await import("@everdict/db");
    const { RunService } = await import("@everdict/application-control");
    const recordings = new InMemoryRecordingStore();
    const store = new Runs();

    // A run interrupted mid-flight, with the previous attempt's frames still in the buffer.
    await store.create({
      id: "r-redrive",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c1",
      status: "running",
      caseSpec: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    } as never);
    await recordings.append("evd-run-r-redrive", {
      track: "logs",
      entry: { t: 1_000, stream: "stdout", text: "attempt A" },
    });
    await recordings.append("evd-run-r-redrive", { track: "frames", entry: { t: 1_100, ref: "a://1", hash: "h1" } });

    let dispatched = 0;
    const service = new RunService({
      store,
      recordingStore: recordings,
      dispatcher: {
        async dispatch(job: CaseJob) {
          dispatched += 1;
          await recordings.append("evd-run-r-redrive", {
            track: "logs",
            entry: { t: 5_000, stream: "stdout", text: "attempt B" },
          });
          return result(job.evalCase.id);
        },
      },
    } as never);

    const record = await store.get("r-redrive");
    const outcome = await service.resume(record as never);
    expect(outcome.kind).toBe("resumed");
    await new Promise((r) => setTimeout(r, 300));
    expect(dispatched).toBe(1);

    // The sealed replay is attempt B's alone. Pre-fix it held both, on one timeline, with nothing marking
    // where the discarded execution ended and the kept one began.
    const sealed = await recordings.get("evd-run-r-redrive");
    expect(sealed?.tracks.logs?.map((l) => l.text)).toEqual(["attempt B"]);
    expect(sealed?.tracks.frames ?? []).toHaveLength(0);
  }, 20_000);
});
