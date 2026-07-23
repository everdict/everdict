import type { PullIngestInput, RunScorecardInput } from "@everdict/application-control";
import { type ScheduleDriver, ScheduleService, type ScheduleSpec, isValidCron } from "@everdict/application-control";
import { BadRequestError, ForbiddenError, NotFoundError, UpstreamError } from "@everdict/contracts";
import { InMemoryScheduleStore, type ScheduleRunTemplate, type ScheduleStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

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
  it("allows a 5-field cron and rejects malformed input", () => {
    expect(isValidCron("0 3 * * *")).toBe(true);
    expect(isValidCron("*/15 * * * 1-5")).toBe(true);
    expect(isValidCron("0 3 * *")).toBe(false); // 4 fields
    expect(isValidCron("0 3 * * * *")).toBe(false); // 6 fields
    expect(isValidCron("nope")).toBe(false);
  });
});

describe("ScheduleService", () => {
  it("creating a schedule fills defaults (UTC/skip/enabled) and is retrievable", async () => {
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

  it("an invalid cron is a BadRequestError (400)", async () => {
    await expect(svc().create({ ...base, cron: "every minute" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("another workspace's schedule is NotFound (404) — no existence leak", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.get("beta", "sch-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(await s.list("beta")).toEqual([]);
    expect(await s.list("acme")).toHaveLength(1);
  });

  it("update pauses (enabled=false) and reschedules (cron)", async () => {
    const s = svc();
    await s.create(base);
    const updated = await s.update("acme", "sch-1", { enabled: false, cron: "0 6 * * 1" });
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe("0 6 * * 1");
  });

  it("update with an invalid cron is 400, a missing id is 404", async () => {
    const s = svc();
    await s.create(base);
    await expect(s.update("acme", "sch-1", { cron: "bad" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(s.update("acme", "nope", { enabled: false })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("after remove a fetch is 404, and removing a missing id is 404", async () => {
    const s = svc();
    await s.create(base);
    await s.remove("acme", "sch-1");
    await expect(s.get("acme", "sch-1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.remove("acme", "sch-1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ScheduleService — Temporal driver sync (slice 2)", () => {
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

  it("calls driver ensure/remove on create/update/remove (reflects paused = !enabled)", async () => {
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
    expect(d.ensured.at(-1)).toMatchObject({ id: "sch-1", paused: true }); // pause synced
    await s.remove("acme", "sch-1");
    expect(d.removed).toEqual(["sch-1"]);
  });

  it("driver ensure failure on create → roll back the DB record (avoid a schedule that exists but never fires)", async () => {
    const store = new InMemoryScheduleStore();
    const driver: ScheduleDriver = {
      async ensure() {
        throw new Error("temporal down");
      },
      async remove() {},
    };
    const s = new ScheduleService({ store, driver, newId: () => "sch-1", now: () => "t" });
    await expect(s.create(base)).rejects.toThrow("temporal down");
    expect(await store.list("acme")).toEqual([]); // rolled back
  });

  // Regression (rich-domain-core S4): the rollback used to be `.catch(() => {})` — an orphaned record
  // (stored in the DB but never firing in Temporal) left zero trace. The ensure failure stays the surfaced
  // error; the rollback failure must ride along.
  function failingRemoveStore(): { store: ScheduleStore; inner: InMemoryScheduleStore } {
    const inner = new InMemoryScheduleStore();
    const store: ScheduleStore = {
      create: (r) => inner.create(r),
      get: (t, i) => inner.get(t, i),
      list: (t) => inner.list(t),
      update: (t, i, p) => inner.update(t, i, p),
      remove: async () => {
        throw new Error("db down");
      },
    };
    return { store, inner };
  }

  it("regression: ensure fails AND the rollback remove fails → the original error surfaces the rollback failure (orphan is not silent)", async () => {
    const { store, inner } = failingRemoveStore();
    const driver: ScheduleDriver = {
      async ensure() {
        throw new Error("temporal down");
      },
      async remove() {},
    };
    const s = new ScheduleService({ store, driver, newId: () => "sch-1", now: () => "t" });
    const err = await s.create(base).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // the original ensure failure is still the error — with the rollback failure attached, not swallowed
    expect((err as Error).message).toContain("temporal down");
    expect((err as Error).message).toContain("rollback also failed");
    expect((err as Error).message).toContain("schedule 'sch-1' is orphaned");
    expect((err as Error).message).toContain("db down");
    expect(await inner.list("acme")).toHaveLength(1); // the orphan remains in the store
  });

  it("regression: an AppError ensure failure keeps its class/code/message and gains rollbackFailed in the envelope data", async () => {
    const { store } = failingRemoveStore();
    const driver: ScheduleDriver = {
      async ensure() {
        throw new UpstreamError("UPSTREAM_ERROR", { address: "temporal:7233" }, "temporal unreachable");
      },
      async remove() {},
    };
    const s = new ScheduleService({ store, driver, newId: () => "sch-1", now: () => "t" });
    const err = await s.create(base).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UpstreamError); // same subclass → same HTTP status (502)
    const app = err as UpstreamError;
    expect(app.code).toBe("UPSTREAM_ERROR");
    expect(app.message).toBe("temporal unreachable"); // original message untouched
    expect(app.extra).toMatchObject({
      address: "temporal:7233", // original data preserved
      schedule: "sch-1",
      rollbackFailed: true,
      rollbackError: "db down",
    });
  });
});

describe("ScheduleService.fire — firing (called by the internal route)", () => {
  it("submits the runTemplate under the creator's identity and records last*", async () => {
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
    // submitted with the creator's identity + the template verbatim, provenance stamped with WHICH schedule fired
    // it (origin.scheduleId → the schedule detail's run-history lookup).
    expect(seen[0]).toMatchObject({
      tenant: "acme",
      submittedBy: "u-1",
      origin: { source: "schedule", scheduleId: "sch-1" },
      dataset: { id: "repo-smoke", version: "latest" },
      harness: { id: "scripted", version: "latest" },
      concurrency: 8,
      runtime: "rt-1",
    });
    // last* recorded
    const rec = await s.get("acme", "sch-1");
    expect(rec).toMatchObject({
      lastScorecardId: "sc-fired",
      lastStatus: "queued",
      lastFiredAt: "2026-06-29T03:00:00.000Z",
    });
  });

  it("a pull-mode schedule fires a trace evaluation over a rolling window (ingestPull, correlate:id, since=now-windowHours)", async () => {
    // "Every day, judge the last 24h of production traces": the fire enumerates the rolling window's traces and judges
    // them directly (no dataset, no harness run).
    const store = new InMemoryScheduleStore();
    const listedWith: Array<{
      source: string;
      opts: { scope?: string; since: string; until: string; limit?: number };
    }> = [];
    const pulled: PullIngestInput[] = [];
    const s = new ScheduleService({
      store,
      newId: () => "sch-1",
      now: () => "2026-06-29T03:00:00.000Z",
      listTraceIds: async (_tenant, source, opts) => {
        listedWith.push({ source, opts });
        return ["t1", "t2"];
      },
      ingestPull: async (input) => {
        pulled.push(input);
        return { id: "sc-eval", status: "queued" };
      },
    });
    await s.create({
      ...base,
      runTemplate: {
        pull: { source: "prod-mlflow", scope: "exp1", windowHours: 24 },
        judges: [{ id: "q", version: "1" }],
      },
    });
    const res = await s.fire("acme", "sch-1");
    expect(res).toEqual({ scorecardId: "sc-eval" });
    // enumerated the rolling window ending at the fire moment (since = now - 24h, until = now)
    expect(listedWith[0]).toEqual({
      source: "prod-mlflow",
      opts: { scope: "exp1", since: "2026-06-28T03:00:00.000Z", until: "2026-06-29T03:00:00.000Z", limit: 500 },
    });
    // judged the listed traces directly — no dataset/harness, correlate forced to id (the ids are real trace ids)
    expect(pulled[0]).toMatchObject({
      tenant: "acme",
      submittedBy: "u-1",
      origin: { source: "schedule", scheduleId: "sch-1" },
      source: { name: "prod-mlflow", correlate: "id" },
      runs: [
        { caseId: "t1", runId: "t1" },
        { caseId: "t2", runId: "t2" },
      ],
      judges: [{ id: "q", version: "1" }],
    });
    expect(pulled[0]?.dataset).toBeUndefined();
    expect(pulled[0]?.harness).toBeUndefined();
  });

  it("a pull-mode schedule with no pull firer configured is a BadRequest (not an auto-disable)", async () => {
    const s = new ScheduleService({ store: new InMemoryScheduleStore(), newId: () => "sch-1", now: () => "t" });
    await s.create({ ...base, runTemplate: { pull: { source: "prod-mlflow", windowHours: 24 }, judges: [] } });
    await expect(s.fire("acme", "sch-1")).rejects.toBeInstanceOf(BadRequestError);
    // Deployment-config problem (missing firer), not schedule-config — the schedule stays enabled.
    expect((await s.get("acme", "sch-1"))?.enabled).toBe(true);
  });

  it("a CONFIG-class fire failure auto-disables the schedule (visible reason + Temporal pause); transient failures don't", async () => {
    const store = new InMemoryScheduleStore();
    const ensured: Array<{ id: string; paused: boolean }> = [];
    const driver: ScheduleDriver = {
      ensure: async (spec: ScheduleSpec) => {
        ensured.push({ id: spec.id, paused: spec.paused });
      },
      remove: async () => {},
    };
    let failWith: Error = new NotFoundError("NOT_FOUND", { dataset: "repo-smoke" }, "dataset not found.");
    const s = new ScheduleService({
      store,
      driver,
      newId: () => "sch-1",
      now: () => "2026-07-08T00:00:00.000Z",
      submitScorecard: async () => {
        throw failWith;
      },
    });
    await s.create(base);
    ensured.length = 0;

    // Deterministic (config) failure — the same fire fails every tick → auto-disable, don't keep firing noise.
    await expect(s.fire("acme", "sch-1")).rejects.toBeInstanceOf(NotFoundError);
    const disabled = await s.get("acme", "sch-1");
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.lastStatus).toContain("Auto-disabled: NOT_FOUND");
    expect(ensured).toEqual([{ id: "sch-1", paused: true }]); // Temporal schedule paused too

    // Transient (infra) failure — the workflow's activity retry owns it; the schedule stays enabled.
    await s.update("acme", "sch-1", { enabled: true });
    ensured.length = 0;
    failWith = new Error("upstream connection reset"); // raw/transient → classified infra retryable
    await expect(s.fire("acme", "sch-1")).rejects.toThrow("connection reset");
    expect((await s.get("acme", "sch-1"))?.enabled).toBe(true);
    expect(ensured).toEqual([]); // no pause
  });

  it("with no submitScorecard (Temporal-less), fire is a BadRequest", async () => {
    const s = new ScheduleService({ store: new InMemoryScheduleStore(), newId: () => "sch-1", now: () => "t" });
    await s.create(base);
    await expect(s.fire("acme", "sch-1")).rejects.toBeInstanceOf(BadRequestError);
  });

  it("firing a missing schedule is 404", async () => {
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      submitScorecard: async () => ({ id: "x", status: "queued" }),
    });
    await expect(s.fire("acme", "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("each fire returns its own submitted scorecard id and records it as lastScorecardId", async () => {
    let i = 0;
    const store = new InMemoryScheduleStore();
    const s = new ScheduleService({
      store,
      newId: () => "sch-1",
      now: () => "t",
      submitScorecard: async () => ({ id: `sc-${++i}`, status: "queued" }),
    });
    await s.create(base);
    expect(await s.fire("acme", "sch-1")).toEqual({ scorecardId: "sc-1" });
    expect((await s.get("acme", "sch-1")).lastScorecardId).toBe("sc-1");
    expect(await s.fire("acme", "sch-1")).toEqual({ scorecardId: "sc-2" });
    expect((await s.get("acme", "sch-1")).lastScorecardId).toBe("sc-2");
  });
});

describe("ScheduleService.finalize — records the fired scorecard's terminal status", () => {
  function svcWith(status: string | undefined) {
    const store = new InMemoryScheduleStore();
    const s = new ScheduleService({
      store,
      newId: () => "sch-1",
      now: () => "t",
      scorecardStatus: async () => status,
    });
    return { s, store };
  }

  it("updates lastStatus to the polled terminal status", async () => {
    const { s } = svcWith("succeeded");
    await s.create(base);
    await s.finalize("acme", "sch-1", "sc-new");
    expect((await s.get("acme", "sch-1")).lastStatus).toBe("succeeded");
  });

  it("a failed fire records lastStatus=failed", async () => {
    const { s } = svcWith("failed");
    await s.create(base);
    await s.finalize("acme", "sch-1", "sc-new");
    expect((await s.get("acme", "sch-1")).lastStatus).toBe("failed");
  });

  it("finalizing a missing schedule is 404", async () => {
    const { s } = svcWith("succeeded");
    await expect(s.finalize("acme", "nope", "sc-new")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ScheduleService.disableByCreator — auto-disable on creator departure", () => {
  it("disables only that creator's active schedules (records reason + Temporal pause); other creators / already-disabled stay as-is", async () => {
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
    await s.create({ ...base, createdBy: "u-2" }); // sch-3 different creator
    ensured.length = 0; // ignore the ensure from create time

    const count = await s.disableByCreator("acme", "u-1");
    expect(count).toBe(1); // only the active sch-1 is a target
    expect((await s.get("acme", "sch-1")).enabled).toBe(false);
    expect((await s.get("acme", "sch-1")).lastStatus).toContain("Auto-disabled");
    expect((await s.get("acme", "sch-3")).enabled).toBe(true); // a different creator stays as-is
    expect(ensured.map((e) => e.id)).toEqual(["sch-1"]); // one Temporal pause
    expect(ensured[0]?.paused).toBe(true);
  });
});

describe("ScheduleService — attaching Temporal-authoritative next fire times (nextFireTimes)", () => {
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

  it("with a driver, attaches nextFireTimes to list/get (queries only enabled)", async () => {
    const seen: string[][] = [];
    const s = svcWithDescribe({ "sch-1": ["2026-07-04T03:00:00.000Z", "2026-07-05T03:00:00.000Z"] }, seen);
    await s.create({ ...base }); // sch-1 enabled
    await s.create({ ...base, enabled: false }); // sch-2 paused → excluded from describe

    const list = await s.list("acme");
    expect(list.find((r) => r.id === "sch-1")?.nextFireTimes).toEqual([
      "2026-07-04T03:00:00.000Z",
      "2026-07-05T03:00:00.000Z",
    ]);
    expect(list.find((r) => r.id === "sch-2")?.nextFireTimes).toBeUndefined(); // paused ones are not attached
    expect(seen.at(-1)).toEqual(["sch-1"]); // describe only enabled ids

    expect((await s.get("acme", "sch-1")).nextFireTimes).toHaveLength(2);
  });

  it("if the driver has no describeMany (dev/Direct), returns as-is without nextFireTimes — the web falls back to a cron approximation", async () => {
    let n = 0;
    const s = new ScheduleService({
      store: new InMemoryScheduleStore(),
      driver: { async ensure() {}, async remove() {} }, // describeMany unimplemented
      newId: () => `sch-${++n}`,
      now: () => "t",
    });
    await s.create({ ...base });
    expect((await s.list("acme"))[0]?.nextFireTimes).toBeUndefined();
    expect((await s.get("acme", "sch-1")).nextFireTimes).toBeUndefined();
  });

  it("even if describeMany fails, the list is returned as-is (only attachment is skipped)", async () => {
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

describe("ScheduleService.update — content-edit ownership (creator/admin) gate", () => {
  it("a content edit by a non-creator/non-admin is a ForbiddenError (403)", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" }); // sch-1
    await expect(
      s.update("acme", "sch-1", { cron: "0 6 * * *" }, { subject: "someone-else", isAdmin: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the creator and a workspace admin can edit content", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" }); // sch-1
    await expect(
      s.update("acme", "sch-1", { name: "renamed" }, { subject: "owner", isAdmin: false }),
    ).resolves.toMatchObject({ name: "renamed" });
    await expect(
      s.update("acme", "sch-1", { cron: "0 7 * * *" }, { subject: "any-admin", isAdmin: true }),
    ).resolves.toMatchObject({ cron: "0 7 * * *" });
  });

  it("pause/resume (enabled-only) is ownership-independent — not a content edit, so not gated", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" }); // sch-1
    await expect(
      s.update("acme", "sch-1", { enabled: false }, { subject: "someone-else", isAdmin: false }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it("with no actor (internal call) the ownership check is skipped", async () => {
    const s = svc();
    await s.create({ ...base, createdBy: "owner" });
    await expect(s.update("acme", "sch-1", { cron: "0 8 * * *" })).resolves.toMatchObject({
      cron: "0 8 * * *",
    });
  });
});
