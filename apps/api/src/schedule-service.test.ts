import { BadRequestError, ForbiddenError, NotFoundError } from "@assay/core";
import { InMemoryScheduleStore, type ScheduleRunTemplate } from "@assay/db";
import { describe, expect, it } from "vitest";
import { type ScheduleDriver, ScheduleService, type ScheduleSpec, isValidCron } from "./schedule-service.js";
import type { RunScorecardInput } from "./scorecard-service.js";

const runTemplate: ScheduleRunTemplate = {
  dataset: { id: "repo-smoke", version: "latest" },
  harness: { id: "scripted", version: "latest" },
  judges: [],
};

function svc(): ScheduleService {
  let n = 0;
  return new ScheduleService({
    store: new InMemoryScheduleStore(),
    newId: () => `sch-${++n}`,
    now: () => "2026-06-29T00:00:00.000Z",
  });
}

const base = { tenant: "acme", createdBy: "u-1", name: "nightly", cron: "0 3 * * *", runTemplate };

describe("isValidCron", () => {
  it("5필드 cron 을 허용하고 오형식을 거부한다", () => {
    expect(isValidCron("0 3 * * *")).toBe(true);
    expect(isValidCron("*/15 * * * 1-5")).toBe(true);
    expect(isValidCron("0 3 * *")).toBe(false); // 4필드
    expect(isValidCron("0 3 * * * *")).toBe(false); // 6필드
    expect(isValidCron("nope")).toBe(false);
  });
});

describe("ScheduleService", () => {
  it("스케줄을 생성하면 기본값(UTC·skip·enabled)이 채워지고 조회된다", async () => {
    const s = svc();
    const created = await s.create(base);
    expect(created).toMatchObject({
      id: "sch-1",
      tenant: "acme",
      name: "nightly",
      cron: "0 3 * * *",
      timezone: "UTC",
      overlapPolicy: "skip",
      enabled: true,
      createdBy: "u-1",
    });
    expect(await s.get("acme", "sch-1")).toEqual(created);
  });

  it("잘못된 cron 은 BadRequestError(400)", async () => {
    await expect(svc().create({ ...base, cron: "every minute" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("다른 워크스페이스의 스케줄은 NotFound(404) — 존재 누출 금지", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.get("beta", "sch-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(await s.list("beta")).toEqual([]);
    expect(await s.list("acme")).toHaveLength(1);
  });

  it("update 로 pause(enabled=false) + 재예약(cron) 한다", async () => {
    const s = svc();
    await s.create(base);
    const updated = await s.update("acme", "sch-1", { enabled: false, cron: "0 6 * * 1" });
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe("0 6 * * 1");
  });

  it("update 의 잘못된 cron 은 400, 없는 id 는 404", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.update("acme", "sch-1", { cron: "bad" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(s.update("acme", "nope", { enabled: false })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("remove 후 조회는 404, 없는 id remove 도 404", async () => {
    const s = svc();
    await s.create(base);
    await s.remove("acme", "sch-1");
    await expect(s.get("acme", "sch-1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.remove("acme", "sch-1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ScheduleService — Temporal 드라이버 동기화 (slice 2)", () => {
  function fakeDriver() {
    const ensured: ScheduleSpec[] = [];
    const removed: string[] = [];
    const driver: ScheduleDriver = {
      async ensure(spec) {
        ensured.push(spec);
      },
      async remove(id) {
        removed.push(id);
      },
    };
    return { driver, ensured, removed };
  }

  it("create/update/remove 시 드라이버 ensure/remove 를 호출(paused = !enabled 반영)", async () => {
    const d = fakeDriver();
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      driver: d.driver,
      newId: () => "sch-1",
      now: () => "t",
    });
    await s.create(base);
    expect(d.ensured.at(-1)).toMatchObject({ id: "sch-1", cron: "0 3 * * *", paused: false });
    await s.update("acme", "sch-1", { enabled: false });
    expect(d.ensured.at(-1)).toMatchObject({ id: "sch-1", paused: true }); // pause 동기화
    await s.remove("acme", "sch-1");
    expect(d.removed).toEqual(["sch-1"]);
  });

  it("create 시 드라이버 ensure 실패 → DB 레코드 롤백(스케줄이 떴는데 발사 안 되는 상태 방지)", async () => {
    const store = new InMemoryScheduleStore();
    const driver: ScheduleDriver = {
      async ensure() {
        throw new Error("temporal down");
      },
      async remove() {},
    };
    const s = new ScheduleService({ store, driver, newId: () => "sch-1", now: () => "t" });
    await expect(s.create(base)).rejects.toThrow("temporal down");
    expect(await store.list("acme")).toEqual([]); // 롤백됨
  });
});

describe("ScheduleService.fire — 발사(internal 라우트가 호출)", () => {
  it("runTemplate 을 생성자 신원으로 submit 하고 last* 를 기록한다", async () => {
    const store = new InMemoryScheduleStore();
    const seen: RunScorecardInput[] = [];
    const s = new ScheduleService({
      store,
      newId: () => "sch-1",
      now: () => "2026-06-29T03:00:00.000Z",
      submitScorecard: async (input) => {
        seen.push(input);
        return { id: "sc-fired", status: "queued" };
      },
    });
    await s.create({ ...base, runTemplate: { ...runTemplate, concurrency: 8, runtime: "rt-1" } });
    const res = await s.fire("acme", "sch-1");
    expect(res).toEqual({ scorecardId: "sc-fired" });
    // 생성자 신원 + 템플릿이 그대로 submit 됐다
    expect(seen[0]).toMatchObject({
      tenant: "acme",
      submittedBy: "u-1",
      dataset: { id: "repo-smoke", version: "latest" },
      harness: { id: "scripted", version: "latest" },
      concurrency: 8,
      runtime: "rt-1",
    });
    // last* 기록
    const rec = await s.get("acme", "sch-1");
    expect(rec).toMatchObject({
      lastScorecardId: "sc-fired",
      lastStatus: "queued",
      lastFiredAt: "2026-06-29T03:00:00.000Z",
    });
  });

  it("submitScorecard 미설정(Temporal 미배포)이면 fire 는 BadRequest", async () => {
    const s = new ScheduleService({ store: new InMemoryScheduleStore(), newId: () => "sch-1", now: () => "t" });
    await s.create(base);
    await expect(s.fire("acme", "sch-1")).rejects.toBeInstanceOf(BadRequestError);
  });

  it("없는 스케줄 fire 는 404", async () => {
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      submitScorecard: async () => ({ id: "x", status: "queued" }),
    });
    await expect(s.fire("acme", "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("연속 발사: 두 번째 fire 는 첫 번째 run id 를 previousScorecardId 로 돌려준다(회귀 baseline)", async () => {
    let i = 0;
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      newId: () => "sch-1",
      now: () => "t",
      submitScorecard: async () => ({ id: `sc-${++i}`, status: "queued" }),
    });
    await s.create(base);
    const first = await s.fire("acme", "sch-1");
    expect(first).toEqual({ scorecardId: "sc-1" }); // 첫 발사 — 직전 없음
    const second = await s.fire("acme", "sch-1");
    expect(second).toEqual({ scorecardId: "sc-2", previousScorecardId: "sc-1" });
  });
});

describe("ScheduleService.finalize — 회귀 알림", () => {
  function svcWith(over: {
    diff?: (
      t: string,
      a: string,
      b: string,
    ) => Promise<{ regressions: { caseId: string; metric: string; baseline: number; candidate: number }[] }>;
    status?: string;
  }) {
    const notified: Array<{
      tenant: string;
      payload: { scheduleName: string; scorecardId: string; previousScorecardId: string };
    }> = [];
    const store = new InMemoryScheduleStore();
    const s = new ScheduleService({
      store,
      newId: () => "sch-1",
      now: () => "t",
      scorecardStatus: async () => over.status ?? "succeeded",
      ...(over.diff ? { diffScorecards: over.diff } : {}),
      notifyRegression: async (tenant, payload) => {
        notified.push({ tenant, payload });
      },
    });
    return { s, store, notified };
  }

  it("직전 run 대비 회귀가 있으면 알림 + lastStatus 갱신", async () => {
    const { s, notified } = svcWith({
      diff: async () => ({ regressions: [{ caseId: "c1", metric: "tests-pass", baseline: 1, candidate: 0 }] }),
    });
    await s.create(base);
    await s.finalize("acme", "sch-1", "sc-new", "sc-prev");
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      tenant: "acme",
      payload: { scheduleName: "nightly", scorecardId: "sc-new", previousScorecardId: "sc-prev" },
    });
    expect((await s.get("acme", "sch-1")).lastStatus).toBe("succeeded");
  });

  it("회귀가 없으면 알림 안 함(lastStatus 는 갱신)", async () => {
    const { s, notified } = svcWith({ diff: async () => ({ regressions: [] }) });
    await s.create(base);
    await s.finalize("acme", "sch-1", "sc-new", "sc-prev");
    expect(notified).toEqual([]);
    expect((await s.get("acme", "sch-1")).lastStatus).toBe("succeeded");
  });

  it("직전 run 이 없으면(첫 발사) diff/알림을 건너뛴다", async () => {
    let diffCalls = 0;
    const { s, notified } = svcWith({
      diff: async () => {
        diffCalls++;
        return { regressions: [] };
      },
    });
    await s.create(base);
    await s.finalize("acme", "sch-1", "sc-new"); // previousScorecardId 없음
    expect(diffCalls).toBe(0);
    expect(notified).toEqual([]);
  });

  it("diff 가 throw(한쪽 미완료)하면 swallow — 회귀 알림만 건너뛴다", async () => {
    const { s, notified } = svcWith({
      diff: async () => {
        throw new Error("not completed");
      },
    });
    await s.create(base);
    await expect(s.finalize("acme", "sch-1", "sc-new", "sc-prev")).resolves.toBeUndefined();
    expect(notified).toEqual([]);
    expect((await s.get("acme", "sch-1")).lastStatus).toBe("succeeded");
  });
});

describe("ScheduleService.disableByCreator — 생성자 이탈 자동 비활성", () => {
  it("해당 생성자의 활성 예약만 비활성(이유 기록 + Temporal pause); 다른 생성자/이미 비활성은 그대로", async () => {
    const ensured: ScheduleSpec[] = [];
    const driver: ScheduleDriver = {
      async ensure(s) {
        ensured.push(s);
      },
      async remove() {},
    };
    let n = 0;
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      driver,
      newId: () => `sch-${++n}`,
      now: () => "t",
    });
    await s.create({ ...base, createdBy: "u-1" }); // sch-1 enabled
    await s.create({ ...base, createdBy: "u-1", enabled: false }); // sch-2 already disabled
    await s.create({ ...base, createdBy: "u-2" }); // sch-3 다른 생성자
    ensured.length = 0; // create 시점의 ensure 는 무시

    const count = await s.disableByCreator("acme", "u-1");
    expect(count).toBe(1); // 활성인 sch-1 만 대상
    expect((await s.get("acme", "sch-1")).enabled).toBe(false);
    expect((await s.get("acme", "sch-1")).lastStatus).toContain("자동 비활성");
    expect((await s.get("acme", "sch-3")).enabled).toBe(true); // 다른 생성자는 그대로
    expect(ensured.map((e) => e.id)).toEqual(["sch-1"]); // Temporal pause 1건
    expect(ensured[0]?.paused).toBe(true);
  });
});

describe("ScheduleService — Temporal authoritative 다음 발사(nextFireTimes) 부착", () => {
  function svcWithDescribe(next: Record<string, string[]>, seen: string[][]): ScheduleService {
    let n = 0;
    const driver: ScheduleDriver = {
      async ensure() {},
      async remove() {},
      async describeMany(ids) {
        seen.push(ids);
        return next;
      },
    };
    return new ScheduleService({
      store: new InMemoryScheduleStore(),
      driver,
      newId: () => `sch-${++n}`,
      now: () => "t",
    });
  }

  it("드라이버가 있으면 list/get 에 nextFireTimes 를 부착한다(활성만 조회)", async () => {
    const seen: string[][] = [];
    const s = svcWithDescribe({ "sch-1": ["2026-07-04T03:00:00.000Z", "2026-07-05T03:00:00.000Z"] }, seen);
    await s.create({ ...base }); // sch-1 enabled
    await s.create({ ...base, enabled: false }); // sch-2 paused → describe 제외

    const list = await s.list("acme");
    expect(list.find((r) => r.id === "sch-1")?.nextFireTimes).toEqual([
      "2026-07-04T03:00:00.000Z",
      "2026-07-05T03:00:00.000Z",
    ]);
    expect(list.find((r) => r.id === "sch-2")?.nextFireTimes).toBeUndefined(); // 일시중지는 미부착
    expect(seen.at(-1)).toEqual(["sch-1"]); // 활성 id 만 describe

    expect((await s.get("acme", "sch-1")).nextFireTimes).toHaveLength(2);
  });

  it("드라이버가 describeMany 를 안 하면(dev/Direct) nextFireTimes 없이 그대로 — 웹이 cron 근사로 폴백", async () => {
    let n = 0;
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      driver: { async ensure() {}, async remove() {} }, // describeMany 미구현
      newId: () => `sch-${++n}`,
      now: () => "t",
    });
    await s.create({ ...base });
    expect((await s.list("acme"))[0]?.nextFireTimes).toBeUndefined();
    expect((await s.get("acme", "sch-1")).nextFireTimes).toBeUndefined();
  });

  it("describeMany 가 실패해도 목록은 그대로 반환한다(부착만 생략)", async () => {
    let n = 0;
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      driver: {
        async ensure() {},
        async remove() {},
        async describeMany() {
          throw new Error("temporal down");
        },
      },
      newId: () => `sch-${++n}`,
      now: () => "t",
    });
    await s.create({ ...base });
    const list = await s.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]?.nextFireTimes).toBeUndefined();
  });
});

describe("ScheduleService.update — 내용 편집 소유권(생성자·admin) 게이트", () => {
  it("생성자/admin 이 아닌 사람의 내용 편집은 ForbiddenError(403)", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" }); // sch-1
    await expect(
      s.update("acme", "sch-1", { cron: "0 6 * * *" }, { subject: "someone-else", isAdmin: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("생성자 본인·워크스페이스 admin 은 내용 편집 가능", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" }); // sch-1
    await expect(
      s.update("acme", "sch-1", { name: "renamed" }, { subject: "owner", isAdmin: false }),
    ).resolves.toMatchObject({ name: "renamed" });
    await expect(
      s.update("acme", "sch-1", { cron: "0 7 * * *" }, { subject: "any-admin", isAdmin: true }),
    ).resolves.toMatchObject({ cron: "0 7 * * *" });
  });

  it("pause/resume(enabled-only)는 소유권 무관 — 내용 편집이 아니므로 게이트 안 함", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" }); // sch-1
    await expect(
      s.update("acme", "sch-1", { enabled: false }, { subject: "someone-else", isAdmin: false }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it("actor 미주입(내부 호출)이면 소유권 검사를 건너뛴다", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" });
    await expect(s.update("acme", "sch-1", { cron: "0 8 * * *" })).resolves.toMatchObject({
      cron: "0 8 * * *",
    });
  });
});
