import { BadRequestError, NotFoundError } from "@assay/core";
import { InMemoryScheduleStore, type ScheduleRunTemplate } from "@assay/db";
import { describe, expect, it } from "vitest";
import { type ScheduleDriver, ScheduleService, type ScheduleSpec, isValidCron } from "./schedule-service.js";
import type { RunScorecardInput } from "./scorecard-service.js";

const runTemplate: ScheduleRunTemplate = {
  dataset: { id: "repo-smoke", version: "latest" },
  harness: { id: "scripted", version: "latest" },
  judges: [],
  metrics: [],
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
});
