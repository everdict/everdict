import { InMemoryRunStore, InMemoryScorecardStore, type RunRecord, type ScorecardRecord } from "@everdict/db";
import { describe, expect, it } from "vitest";
import type { ScheduleRecordWithNext } from "../scheduling/schedule-service.js";
import { QueueService } from "./queue-service.js";

const card = (id: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "queued",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  ...over,
});

const runRec = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "h", version: "1" },
  caseId: "c1",
  status: "queued",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  ...over,
});

const schedule = (over: Partial<ScheduleRecordWithNext> = {}): ScheduleRecordWithNext => ({
  id: "sch1",
  tenant: "acme",
  name: "nightly",
  cron: "0 3 * * *",
  timezone: "UTC",
  overlapPolicy: "skip",
  enabled: true,
  createdBy: "alice",
  runTemplate: {
    dataset: { id: "d", version: "latest" },
    harness: { id: "h", version: "latest" },
    judges: [],
    runtime: "docker",
  },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  nextFireTimes: ["2026-07-04T03:00:00.000Z"],
  ...over,
});

async function fixtures() {
  const scorecards = new InMemoryScorecardStore();
  const runs = new InMemoryRunStore();
  return { scorecards, runs };
}

describe("QueueService.snapshot", () => {
  it("aggregates running/waiting (FIFO)/next fires per runtime lane — batch=1 item + progress", async () => {
    const { scorecards, runs } = await fixtures();
    // docker lane: a running batch (2 finished children + 1 running) + a next scheduled fire
    await scorecards.create(card("sc-run", { status: "running", runtime: "docker", createdBy: "alice" }));
    for (const [i, st] of (["succeeded", "failed", "running"] as const).entries()) {
      await runs.create(runRec(`child-${i}`, { status: st, parentScorecardId: "sc-run", runtime: "docker" }));
    }
    // default backend lane: a waiting batch
    await scorecards.create(card("sc-wait", { createdAt: "2026-07-03T01:00:00.000Z" }));
    // my (bob's) runner lane: a waiting standalone run + someone else's (carol's) runner job (personal queue — invisible to others)
    await runs.create(runRec("r1", { runtime: "self:mac", createdBy: "bob", trigger: "web" }));
    await runs.create(runRec("r-other", { runtime: "self:carol-pc", createdBy: "carol" }));
    // finished states aren't in the queue
    await scorecards.create(card("sc-done", { status: "succeeded" }));

    const svc = new QueueService({
      scorecards,
      runs,
      schedules: { list: async () => [schedule()] },
      runtimes: { list: async () => [{ id: "docker" }] },
      myRunners: async (subject) => (subject === "bob" ? [{ id: "mac", label: "bob-macbook" }] : []),
      caseCountFor: async () => 3,
      now: () => "2026-07-03T12:00:00.000Z",
    });
    const snap = await svc.snapshot("acme", "bob");

    // workspace queue = shared runtimes only (self:* excluded), personal queue = my runners only. Others' self items are excluded from tallies too.
    expect(snap.totals).toEqual({ running: 1, queued: 2, upcoming: 1 });
    expect(snap.workspace.map((l) => l.runtime)).toEqual(["", "docker"]); // default lane at the top, no self
    expect(snap.personal.map((l) => l.runtime)).toEqual(["self:mac"]);
    expect(snap.personal[0]?.label).toBe("bob-macbook"); // lane label = runner hostname
    const base = snap.workspace[0];
    const docker = snap.workspace[1];
    const self = snap.personal[0];

    expect(base?.queued.map((i) => i.id)).toEqual(["sc-wait"]);
    expect(docker?.registered).toBe(true);
    expect(docker?.running[0]).toMatchObject({
      type: "scorecard",
      id: "sc-run",
      createdBy: "alice",
      progress: { done: 2, active: 1, total: 3 },
    });
    expect(docker?.upcoming[0]).toMatchObject({ scheduleId: "sch1", name: "nightly", at: "2026-07-04T03:00:00.000Z" });
    expect(self?.queued[0]).toMatchObject({ type: "run", id: "r1", caseId: "c1", trigger: "web" });
    // the finished batch (sc-done), batch child runs, and others' self items don't appear
    const allIds = [...snap.workspace, ...snap.personal].flatMap((l) => [...l.running, ...l.queued]).map((i) => i.id);
    expect(allIds).not.toContain("sc-done");
    expect(allIds).not.toContain("r-other");
    expect(allIds.filter((x) => x.startsWith("child-"))).toEqual([]);
  });

  it("a partial (subset) batch's progress denominator is the selected size, not the full dataset", async () => {
    const { scorecards, runs } = await fixtures();
    await scorecards.create(
      card("sc-subset", {
        status: "running",
        runtime: "docker",
        subset: { total: 601, selected: 12 },
      }),
    );
    await runs.create(runRec("child-a", { status: "succeeded", parentScorecardId: "sc-subset", runtime: "docker" }));
    const svc = new QueueService({
      scorecards,
      runs,
      caseCountFor: async () => 601, // full dataset size — must NOT be used for a subset run
      now: () => "2026-07-03T12:00:00.000Z",
    });
    const snap = await svc.snapshot("acme", "bob");
    const item = snap.workspace.flatMap((l) => l.running).find((i) => i.id === "sc-subset");
    expect(item?.progress).toEqual({ done: 1, active: 0, total: 12 });
  });

  it("the waiting queue is createdAt ascending (FIFO) — the front is the next item", async () => {
    const { scorecards, runs } = await fixtures();
    await scorecards.create(card("later", { createdAt: "2026-07-03T02:00:00.000Z" }));
    await scorecards.create(card("first", { createdAt: "2026-07-03T01:00:00.000Z" }));
    const svc = new QueueService({ scorecards, runs });
    const snap = await svc.snapshot("acme");
    expect(snap.workspace[0]?.queued.map((i) => i.id)).toEqual(["first", "later"]);
  });

  it("disabled schedules and schedules with no fire time aren't in upcoming; registered runtimes surface empty lanes too", async () => {
    const { scorecards, runs } = await fixtures();
    const svc = new QueueService({
      scorecards,
      runs,
      schedules: {
        list: async () => [
          schedule({ id: "off", enabled: false }),
          schedule({ id: "no-fires", nextFireTimes: undefined }),
        ],
      },
      runtimes: { list: async () => [{ id: "idle-k8s" }] },
    });
    const snap = await svc.snapshot("acme");
    expect(snap.totals.upcoming).toBe(0);
    const idle = snap.workspace.find((l) => l.runtime === "idle-k8s");
    expect(idle).toMatchObject({ registered: true, running: [], queued: [], upcoming: [] });
  });

  it("lane admission maps scheduler/breaker state per runtime — cross-tenant numbers never leak", async () => {
    const { scorecards, runs } = await fixtures();
    const svc = new QueueService({
      scorecards,
      runs,
      runtimes: { list: async () => [{ id: "nomad-local" }, { id: "kind-local" }] },
      schedulerStats: () => ({
        queued: 9, // global — never surfaced as-is
        inFlight: {
          "rt:acme:nomad-local@1.0.0": 2,
          "rt:acme:nomad-local@1.0.1": 1, // versions of the same runtime sum into one lane
          "rt:beta:nomad-local@1.0.0": 7, // ANOTHER tenant's runtime of the same id — must not count
          nomad: 4, // global env backend → the '' (default) lane
        },
        memInFlightMb: { "rt:acme:nomad-local@1.0.1": 512 },
        tenantInFlight: { acme: 3, beta: 7 },
        queuedByTenant: { acme: 1, beta: 8 },
      }),
      circuitStats: () => ({
        "acme:nomad-local": { consecutive: 3, open: true },
        "beta:kind-local": { consecutive: 3, open: true }, // another tenant's circuit — invisible here
      }),
      tenantQuotaFor: (t) => (t === "acme" ? 5 : undefined),
      runtimeEnvelopeFor: async (_t, id) =>
        id === "nomad-local" ? { maxConcurrent: 10, memoryBudgetMb: 600 } : undefined,
    });

    const snap = await svc.snapshot("acme");
    // Workspace scheduler slice — acme's numbers only, plus the operator quota dial.
    expect(snap.scheduler).toEqual({ queued: 1, inFlight: 3, quota: 5 });
    const nomadLane = snap.workspace.find((l) => l.runtime === "nomad-local");
    expect(nomadLane?.admission).toEqual({
      inFlight: 3, // 2 + 1 (acme's two versions) — beta's 7 excluded
      memInFlightMb: 512,
      memoryBudgetMb: 600,
      maxConcurrent: 10,
      circuit: { open: true, consecutive: 3 },
    });
    const kindLane = snap.workspace.find((l) => l.runtime === "kind-local");
    expect(kindLane?.admission).toEqual({ inFlight: 0 }); // no envelope declared, no circuit → bare in-flight
    const defaultLane = snap.workspace.find((l) => l.runtime === "");
    expect(defaultLane?.admission?.inFlight).toBe(4); // the global env backend's aggregate load
  });
});
