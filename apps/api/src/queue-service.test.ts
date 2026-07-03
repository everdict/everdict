import { InMemoryRunStore, InMemoryScorecardStore, type RunRecord, type ScorecardRecord } from "@assay/db";
import { describe, expect, it } from "vitest";
import { QueueService } from "./queue-service.js";
import type { ScheduleRecordWithNext } from "./schedule-service.js";

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
  it("런타임 레인별로 실행 중/대기(FIFO)/다음 예약을 집계한다 — 배치=1작업 + 진행률", async () => {
    const { scorecards, runs } = await fixtures();
    // docker 레인: 실행 중 배치(자식 2 종결 + 1 실행 중) + 다음 예약 발사
    await scorecards.create(card("sc-run", { status: "running", runtime: "docker", createdBy: "alice" }));
    for (const [i, st] of (["succeeded", "failed", "running"] as const).entries()) {
      await runs.create(runRec(`child-${i}`, { status: st, parentScorecardId: "sc-run", runtime: "docker" }));
    }
    // 기본 백엔드 레인: 대기 배치
    await scorecards.create(card("sc-wait", { createdAt: "2026-07-03T01:00:00.000Z" }));
    // self 레인: 대기 단발 run(standalone)
    await runs.create(runRec("r1", { runtime: "self:mac", createdBy: "bob", trigger: "web" }));
    // 종결 상태는 큐에 없다
    await scorecards.create(card("sc-done", { status: "succeeded" }));

    const svc = new QueueService({
      scorecards,
      runs,
      schedules: { list: async () => [schedule()] },
      runtimes: { list: async () => [{ id: "docker" }] },
      caseCountFor: async () => 3,
      now: () => "2026-07-03T12:00:00.000Z",
    });
    const snap = await svc.snapshot("acme");

    expect(snap.totals).toEqual({ running: 1, queued: 2, upcoming: 1 });
    expect(snap.lanes.map((l) => l.runtime)).toEqual(["", "docker", "self:mac"]); // 기본 레인 맨 위
    const base = snap.lanes[0];
    const docker = snap.lanes[1];
    const self = snap.lanes[2];

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
    // 종결 배치(sc-done)와 배치 자식 run 은 항목으로 나타나지 않는다(자식은 진행률로 접힘)
    const allIds = snap.lanes.flatMap((l) => [...l.running, ...l.queued]).map((i) => i.id);
    expect(allIds).not.toContain("sc-done");
    expect(allIds.filter((x) => x.startsWith("child-"))).toEqual([]);
  });

  it("대기 큐는 createdAt 오름차순(FIFO) — 맨 앞이 다음 작업", async () => {
    const { scorecards, runs } = await fixtures();
    await scorecards.create(card("later", { createdAt: "2026-07-03T02:00:00.000Z" }));
    await scorecards.create(card("first", { createdAt: "2026-07-03T01:00:00.000Z" }));
    const svc = new QueueService({ scorecards, runs });
    const snap = await svc.snapshot("acme");
    expect(snap.lanes[0]?.queued.map((i) => i.id)).toEqual(["first", "later"]);
  });

  it("비활성 예약·발사 시각 없는 예약은 upcoming 에 없다; 등록 런타임은 빈 레인도 노출", async () => {
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
    const idle = snap.lanes.find((l) => l.runtime === "idle-k8s");
    expect(idle).toMatchObject({ registered: true, running: [], queued: [], upcoming: [] });
  });
});
