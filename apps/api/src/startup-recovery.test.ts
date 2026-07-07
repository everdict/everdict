import { InMemoryRunStore, InMemoryScorecardStore, type RunRecord, type ScorecardRecord } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { recoverInterrupted } from "./startup-recovery.js";

const card = (id: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "running",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  ...over,
});

const runRec = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  tenant: "acme",
  harness: { id: "h", version: "1" },
  caseId: "c1",
  status: "running",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  ...over,
});

describe("recoverInterrupted (부팅 시 고아 작업 회수)", () => {
  it("재시작으로 고아가 된 queued/running 배치·자식·standalone run 을 INTERRUPTED 로 종결한다", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await scorecards.create(card("zombie-running"));
    await scorecards.create(card("zombie-queued", { status: "queued" }));
    await scorecards.create(card("done", { status: "succeeded" }));
    // zombie-running 의 자식: 종결 1 + 실행 중 1(고아)
    await runs.create(runRec("child-done", { status: "succeeded", parentScorecardId: "zombie-running" }));
    await runs.create(runRec("child-stuck", { parentScorecardId: "zombie-running" }));
    // standalone: 고아 1 + 종결 1
    await runs.create(runRec("solo-stuck"));
    await runs.create(runRec("solo-done", { status: "failed" }));

    const res = await recoverInterrupted({ scorecards, runs, now: () => "2026-07-04T00:00:00.000Z" });

    expect(res).toEqual({ scorecards: 2, runs: 2 });
    expect((await scorecards.get("zombie-running"))?.status).toBe("failed");
    expect((await scorecards.get("zombie-running"))?.error?.code).toBe("INTERRUPTED");
    expect((await scorecards.get("zombie-queued"))?.status).toBe("failed");
    expect((await scorecards.get("done"))?.status).toBe("succeeded"); // 종결 상태는 무변경
    expect((await runs.get("child-stuck"))?.status).toBe("failed");
    expect((await runs.get("child-done"))?.status).toBe("succeeded");
    expect((await runs.get("solo-stuck"))?.status).toBe("failed");
    expect((await runs.get("solo-done"))?.error).toBeUndefined(); // 기존 실패 레코드 덮어쓰지 않음
  });

  it("고아가 없으면 아무것도 바꾸지 않는다", async () => {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await scorecards.create(card("done", { status: "succeeded" }));
    expect(await recoverInterrupted({ scorecards, runs })).toEqual({ scorecards: 0, runs: 0 });
  });
});
