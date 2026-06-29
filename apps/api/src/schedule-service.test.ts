import { BadRequestError, NotFoundError } from "@assay/core";
import { InMemoryScheduleStore, type ScheduleRunTemplate } from "@assay/db";
import { describe, expect, it } from "vitest";
import { ScheduleService, isValidCron } from "./schedule-service.js";

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
