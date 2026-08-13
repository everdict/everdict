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

    // …AND THE PREVIOUS ATTEMPT'S RECORDER IS REVOKED, not merely erased (mig 0173). The paused replica whose
    // return is the entire reason fencing exists wakes AFTER the reset and goes on writing under the
    // generation it was started with. A reset that only cleared history would accept this and interleave two
    // executions in the replay the winner seals.
    await recordings.append(
      "evd-run-r-redrive",
      { track: "logs", entry: { t: 9_000, stream: "stdout", text: "attempt A, still going" } },
      0,
    );
    expect((await recordings.get("evd-run-r-redrive"))?.tracks.logs?.map((l) => l.text)).toEqual(["attempt B"]);
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-152.
//
// THE LAST PLACE A DISPLACED DRIVER COULD STILL PUBLISH.
//
// A batch proves its authority before it dispatches, and its child row is now created under the parent's
// fencing token — so a driver displaced BEFORE a case opens neither commits to it nor runs it. What was left
// is the case already in flight when the takeover lands. That one executes, and then its driver publishes:
// the execution plane, the judges' planes on top of it, and the child's settle.
//
// The settle is refused, which used to be treated as enough. It is not, because a trajectory keeps the FIRST
// segment per emitter — immutable evidence, deliberately. So the displaced driver planted the permanent
// execution plane of a case whose outcome was thrown away, and the successor's re-drive, whose result the
// child actually keeps, found its own seal refused as a re-offer. `result = B, trajectory = A`, one level
// below where that sentence was first fixed.
//
// The case really did execute. It is simply no longer this driver's to publish — which is a question asked
// once, right before anything is written, and answered by the same fence everything else here uses.
describeTrust("TRUST-152 — a driver displaced mid-case publishes no evidence for it", () => {
  it("the execution plane of a case whose settle will be refused is never sealed", async () => {
    const { InMemoryTrajectoryStore } = await import("@everdict/db");
    const trajectories = new InMemoryTrajectoryStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "one",
      version: "1.0.0",
      tags: [],
      cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
    });
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    runStore.attachScorecards(store);

    let takeover: (() => Promise<void>) | undefined;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          // The takeover lands WHILE this case runs — after its child row was committed, before its evidence.
          if (takeover) {
            const claim = takeover;
            takeover = undefined;
            await claim();
          }
          return {
            ...result(job.evalCase.id),
            trace: [{ kind: "message" as const, t: 0, role: "assistant" as const, text: "displaced driver's run" }],
          };
        },
      },
      store,
      runStore,
      trajectories,
      datasets,
      harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    } as never);

    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "one", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    takeover = async () => {
      const claimed = await store.update(record.id, { ownerReplica: "cp-b" }, undefined, {
        expectNonTerminal: true,
        claimOwnership: true,
      });
      expect(claimed?.ownerEpoch).toBeGreaterThan(0);
    };
    await new Promise((r) => setTimeout(r, 600));

    // No child of this batch carries a trajectory: the displaced driver published nothing, so the seal its
    // successor's re-drive makes will be the first one — and therefore the one that stays.
    const children = await runStore.list("acme", { scorecardId: record.id });
    for (const child of children) expect(await trajectories.get("acme", child.id)).toBeUndefined();
    // …and the child is not terminal either, so the batch its successor drives still has the case to run.
    for (const child of children) expect(["queued", "running"]).toContain(child.status);
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-153.
//
// A COMPLETION CALLBACK IS A SETTLEMENT'S EFFECT, NOT A SETTLING PROCESS'S.
//
// The run webhook was POSTed inline by whichever process finished the run, from a URL that existed only in
// the submit request. Three consequences, all the same mistake: a driver whose terminal write was REFUSED
// still called back; a control plane that restarted between dispatch and settlement dropped the callback
// with no trace; and a replica taken over could not hand it on, because the replacement — the one that would
// actually settle the run — had never seen it. The caller waits on an answer nobody is able to send.
//
// It is now a property of the RUN, delivered off the terminal FACT that the settlement wrote in its own
// transaction. So the callback exists exactly when the settlement does, and any process walking the log can
// make it — including one that boots afterwards, which is the case asserted here.
describeTrust("TRUST-153 — a run's callback survives the process that started it", () => {
  it("a settled run's webhook is delivered from the terminal fact by a later process", async () => {
    const { runWebhookConsumer } = await import("@everdict/application-control");
    const runs = new InMemoryRunStore();
    const calls: Array<{ url: string; status: string; eventHeader: string | null }> = [];
    const fakeFetch = (async (url: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({
        url: String(url),
        status: String(body.status),
        eventHeader: init?.headers?.["x-everdict-event"] ?? null,
      });
      return new Response("ok");
    }) as unknown as typeof fetch;

    // A run that settled — and whose callback was recorded when it was submitted, not held by the submitter.
    await runs.create({
      id: "run-callback",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c1",
      status: "succeeded",
      webhookUrl: "https://hook.example/cb",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:01.000Z",
    } as never);

    // …and a DIFFERENT process — this consumer — walks the log afterwards and makes the call.
    const consumer = runWebhookConsumer({ runs, fetchImpl: fakeFetch });
    expect(consumer.kinds).toContain("run.completed");
    await consumer.handle({
      id: "evt-1",
      tenant: "acme",
      kind: "run.completed",
      subject: { type: "run", id: "run-callback" },
      message: "Run run-callback completed",
      createdAt: "2026-08-13T00:00:01.000Z",
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hook.example/cb");
    expect(calls[0]?.status).toBe("succeeded");
    // …carrying the event id, which is what lets a receiver dedup an at-least-once delivery.
    expect(calls[0]?.eventHeader).toBe("evt-1");
  }, 20_000);

  it("a failing endpoint is a FAILED delivery — the runner retries it rather than calling it done", async () => {
    const { runWebhookConsumer } = await import("@everdict/application-control");
    const runs = new InMemoryRunStore();
    await runs.create({
      id: "run-cb-500",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c1",
      status: "failed",
      webhookUrl: "https://hook.example/down",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:01.000Z",
    } as never);
    const consumer = runWebhookConsumer({
      runs,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(
      consumer.handle({
        id: "evt-2",
        tenant: "acme",
        kind: "run.failed",
        subject: { type: "run", id: "run-cb-500" },
        message: "Run run-cb-500 failed",
        createdAt: "2026-08-13T00:00:01.000Z",
      } as never),
    ).rejects.toThrow(/503/);
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-154.
//
// A TERMINAL ROW IS NOT A TERMINAL FACT, AND A CALLBACK IS NOT A PUBLIC FIELD.
//
// The durable callback hangs off the run's terminal fact, which made two silences suddenly matter. Recovery
// wrote its outcomes as raw patches carrying no facts — an adopted result settled `succeeded`, an unresumable
// run settled `failed`, and neither told anybody. So the callback fired for runs that ended normally and
// stayed silent for exactly the runs it was built for: the ones whose original process died.
//
// The second half is what durability cost. A webhook URL is routinely the credential itself
// (`…/hook/<secret>`), and it had been added to the record every workspace member can read through
// `GET /runs/:id`, the list, and the MCP tools that hand an agent the whole record. Storing it and serving it
// are two decisions and only the first was needed.
describeTrust("TRUST-154 — a recovered run's ending is announced, and its callback is not published", () => {
  it("an adopted recovery emits the terminal fact the callback rides on", async () => {
    const { RunService } = await import("@everdict/application-control");
    const store = new InMemoryRunStore();
    const pushed: Array<{ kind: string }> = [];
    const service = new RunService({
      store,
      dispatcher: {
        async dispatch(job: CaseJob) {
          return result(job.evalCase.id);
        },
      },
      events: {
        pushPersisted: (facts: Array<{ record: { kind: string } }>) => pushed.push(...facts.map((f) => f.record)),
      },
      newId: () => `evt-${pushed.length + 1}`,
    } as never);

    await store.create({
      id: "run-adopted",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c1",
      status: "running",
      webhookUrl: "https://hook.example/cb",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    } as never);

    const record = await store.get("run-adopted");
    const outcome = await service.resume(record as never, result("c1"));
    expect(outcome.kind).toBe("resumed");
    expect((await store.get("run-adopted"))?.status).toBe("succeeded");
    // Pre-fix `adopt` returned `facts: []`, so the run ended and the world was never told — and the callback,
    // which is delivered off exactly this fact, never fired for the one case it exists for.
    expect(pushed.map((f) => f.kind)).toContain("run.completed");
  }, 20_000);

  it("the callback is stored but never served — it is a delivery target, not a run property", async () => {
    const { RunService } = await import("@everdict/application-control");
    const store = new InMemoryRunStore();
    const service = new RunService({
      store,
      dispatcher: {
        async dispatch(job: CaseJob) {
          return result(job.evalCase.id);
        },
      },
    } as never);
    const submitted = await service.submit({
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      webhookUrl: "https://hook.example/cb-with-secret",
    } as never);

    // Stored, because the callback must outlive the process that took the request…
    expect((await store.get(submitted.id))?.webhookUrl).toBe("https://hook.example/cb-with-secret");
    // …and absent from what a reader gets, because the URL is frequently the credential.
    expect((await service.get(submitted.id))?.webhookUrl).toBeUndefined();
    expect((await service.list("acme")).every((r) => r.webhookUrl === undefined)).toBe(true);
  }, 20_000);

  it("a callback pointing inside our own network is refused rather than dialled", async () => {
    const { refuseUnsafeCallback } = await import("@everdict/application-control");
    // The control plane sits in a network the submitter does not: this is SSRF in its plainest form.
    expect(() => refuseUnsafeCallback("http://169.254.169.254/latest/meta-data/", false)).toThrow();
    expect(() => refuseUnsafeCallback("https://169.254.169.254/latest/meta-data/", false)).toThrow(/private/);
    expect(() => refuseUnsafeCallback("https://localhost:8080/hook", false)).toThrow(/private/);
    expect(() => refuseUnsafeCallback("https://10.0.0.5/hook", false)).toThrow(/private/);
    expect(refuseUnsafeCallback("https://hooks.example.com/cb", false).hostname).toBe("hooks.example.com");
    // …and a single-tenant install that genuinely posts inside its own network can say so.
    expect(refuseUnsafeCallback("https://localhost:8080/hook", true).hostname).toBe("localhost");
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-155.
//
// HOLDING AN EPOCH IN A CONTEXT IS NOT PROVING ONE.
//
// The Temporal driver's batch context has carried its `driverEpoch` since the fence was built, and the write
// that decides the batch's answer — the finalize, the canonical parent outcome every reader treats as THE
// result — never proved it. A takeover raises the epoch and leaves the batch OPEN, which is exactly the state
// `over: "open"` accepts, so a paused finalizer woke up and settled a batch it no longer owned, beating its
// successor to the outcome. Not a duplicate notification: the parent's verdict itself, written by the loser.
//
// …and the same driver's judges published without the post-judge probe the in-process loop had just been
// given, so the race the fix was named after stayed open on the driver an operator running Temporal uses.
describeTrust("TRUST-155 — the Temporal finalize settles under the epoch its context holds", () => {
  it("a displaced finalizer cannot write the batch's outcome", async () => {
    const store = new InMemoryScorecardStore();
    await store.create({
      id: "sc-final",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      status: "running",
      ownerReplica: "cp-a",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    } as never);

    // A's activity context holds epoch 0 and pauses on its way to the finalize.
    const heldByA = (await store.get("sc-final"))?.ownerEpoch ?? 0;
    expect(heldByA).toBe(0);

    // B declares A stale and claims the batch. The row stays OPEN — a takeover is not a settlement.
    const claimed = await store.update("sc-final", { ownerReplica: "cp-b" }, undefined, {
      expectNonTerminal: true,
      claimOwnership: true,
    });
    expect(claimed?.ownerEpoch).toBe(1);
    expect(claimed?.status).toBe("running");

    // A wakes and finalizes. Terminal fence alone lets this through — the batch IS open — which is exactly
    // how a displaced driver used to win the outcome.
    const { settleScorecard } = await import("@everdict/application-control");
    const stale = await settleScorecard(
      store,
      "sc-final",
      { status: "succeeded", updatedAt: "2026-08-13T00:01:00.000Z" },
      undefined,
      { over: "open", epoch: heldByA },
    );
    expect(stale).toBeUndefined();
    expect((await store.get("sc-final"))?.status).toBe("running");

    // …and B, holding what it won, finalizes normally.
    const settled = await settleScorecard(
      store,
      "sc-final",
      { status: "succeeded", updatedAt: "2026-08-13T00:01:01.000Z" },
      undefined,
      { over: "open", epoch: claimed?.ownerEpoch ?? 0 },
    );
    expect(settled?.status).toBe("succeeded");
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-156.
//
// A TERMINAL CAS WON IS NOT A TERMINAL PAYLOAD IMMUTABLE.
//
// Every terminal write on a child proves the child's epoch AND the parent's driver. Then the batch's
// write-back — the amendment that reflects judged/offloaded results onto the children — ran with neither,
// carrying only "not cancelled". So a driver that LOST the settle could still land its result on the row
// afterwards: the winner's status beside the loser's evidence. `parent judgment = B, child evidence = A`,
// the same split three reviews have now chased through four different artifacts, arriving this time through
// the one write that was never about status.
describeTrust("TRUST-156 — a losing driver cannot amend the winner's child result", () => {
  it("the write-back proves the parent's driver, so a stale result does not land", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    runs.attachScorecards(scorecards);
    await scorecards.create({
      id: "sc-wb",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      status: "running",
      ownerReplica: "cp-a",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    } as never);
    await runs.create({
      id: "child-wb",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c1",
      status: "succeeded",
      parentScorecardId: "sc-wb",
      result: { ...result("c1"), snapshot: { kind: "prompt", output: "B's answer" } },
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:01.000Z",
    } as never);

    // B takes the batch: the parent's token moves, the child's does not.
    const claimed = await scorecards.update("sc-wb", { ownerReplica: "cp-b" }, undefined, {
      expectNonTerminal: true,
      claimOwnership: true,
    });
    expect(claimed?.ownerEpoch).toBe(1);

    // A's write-back arrives late, under the epoch it held. The row is terminal and not cancelled, which is
    // everything the old condition asked.
    const stale = await runs.update(
      "child-wb",
      {
        result: { ...result("c1"), snapshot: { kind: "prompt", output: "A's stale answer" } },
        updatedAt: "2026-08-13T00:02:00.000Z",
      },
      undefined,
      { expectNotCancelled: true, parentDriver: { scorecardId: "sc-wb", epoch: 0 } },
    );
    expect(stale).toBeUndefined();
    expect((await runs.get("child-wb"))?.result?.snapshot).toMatchObject({ output: "B's answer" });

    // …and B's own write-back lands, because the amendment is the batch's to make.
    const amended = await runs.update(
      "child-wb",
      {
        result: { ...result("c1"), snapshot: { kind: "prompt", output: "B's amended answer" } },
        updatedAt: "2026-08-13T00:02:01.000Z",
      },
      undefined,
      { expectNotCancelled: true, parentDriver: { scorecardId: "sc-wb", epoch: 1 } },
    );
    expect(amended?.result?.snapshot).toMatchObject({ output: "B's amended answer" });
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-157.
//
// A HOSTNAME IS NOT A DESTINATION.
//
// The callback's SSRF check read the hostname the tenant wrote, which is the string, not the place. A name
// its owner controls resolves to whatever their DNS says — `https://hook.attacker.example/` answering
// `169.254.169.254` passes every literal test and then reads a credential from the metadata service, from
// inside a network the submitter is not in.
//
// So the name is resolved and the ADDRESSES are judged, and the address that passed is PINNED into the
// request — a name that answers publicly once and privately a moment later would otherwise be a check that
// proved nothing. The Host header keeps the original name so TLS and the receiver's routing still see what
// was configured.
describeTrust("TRUST-157 — a callback is judged by where its name goes, not by how it reads", () => {
  it("a public name that resolves privately is refused", async () => {
    const { refuseUnsafeCallback, resolvePublicTarget } = await import("@everdict/application-control");
    const url = refuseUnsafeCallback("https://hook.attacker.example/cb", false); // the literal check passes…
    await expect(resolvePublicTarget(url, async () => ["169.254.169.254"])).rejects.toThrow(/private address/);
    await expect(resolvePublicTarget(url, async () => ["10.0.0.7"])).rejects.toThrow(/private address/);
    // …and a name that resolves nowhere is a delivery that cannot be made, said out loud.
    await expect(resolvePublicTarget(url, async () => [])).rejects.toThrow(/resolves to nothing/);
  }, 20_000);

  it("a public name is dialled at the address that passed, under its own Host", async () => {
    const { refuseUnsafeCallback, resolvePublicTarget } = await import("@everdict/application-control");
    const url = refuseUnsafeCallback("https://hooks.example.com/cb?token=abc", false);
    const target = await resolvePublicTarget(url, async () => ["93.184.216.34"]);
    // Pinned: the connection goes to the address the check judged, closing the rebinding window between them.
    expect(target.url.hostname).toBe("93.184.216.34");
    expect(target.url.pathname + target.url.search).toBe("/cb?token=abc");
    // …and the receiver is still addressed by the name it was configured with.
    expect(target.host).toBe("hooks.example.com");
  }, 20_000);
});

// Trust suite (docs/trust-certification.md) — TRUST-158.
//
// TERMINAL MEANS FINALIZED, AND FINALIZED INCLUDES THE ARTIFACTS.
//
// The child stopped going terminal before its judges landed two reviews ago, and everything ELSE a case
// produces still happened afterwards: the screenshot offload and the replay seal ran later in the batch
// pipeline. A crash in between left a row recovery reads as finished evidence — do not re-run, do not
// re-judge — whose snapshot was still inline base64 and whose replay had no ref. Judged is not assembled.
//
// The artifacts are assembled before the ONE terminal write now, so whatever they produced is part of it.
// Both remain best-effort by contract: a failed offload or an unsealed recording must never cost a case its
// verdict — what changed is when they happen, not whether they can fail.
describeTrust("TRUST-158 — a terminal child carries its assembled evidence, not just its verdict", () => {
  it("the child's own terminal write already holds the replay ref", async () => {
    const { InMemoryRecordingStore } = await import("@everdict/db");
    const recordings = new InMemoryRecordingStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "one",
      version: "1.0.0",
      tags: [],
      cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
    });
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    runStore.attachScorecards(store);

    const service = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob) {
          // A frame teed under the id this case was DISPATCHED with — which is what the child stamps (mig 0172).
          await recordings.append(job.runId ?? "", { track: "frames", entry: { t: 1, ref: "memory://f" } });
          return result(job.evalCase.id);
        },
      },
      store,
      runStore,
      recordingStore: recordings,
      datasets,
      harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
    } as never);

    const record = await service.submit({
      tenant: "acme",
      dataset: { id: "one", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      createdBy: "u",
      concurrency: 1,
    } as never);
    await new Promise((r) => setTimeout(r, 600));

    const children = await runStore.list("acme", { scorecardId: record.id });
    expect(children).toHaveLength(1);
    const child = children[0];
    // The row a recovery would read as finished evidence: terminal, judged, AND assembled.
    expect(child?.status).toBe("succeeded");
    expect(child?.result?.recordingRef).toBeDefined();
    // …and it names the id the case actually ran under, which a trialled case cannot re-derive.
    expect(child?.executionId).toBe(`evd-${record.id}-c1`);
  }, 20_000);
});
