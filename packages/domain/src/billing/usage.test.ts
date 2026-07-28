import { describe, expect, it } from "vitest";
import { inMemoryUsageMeter, totalUsage } from "./usage.js";

describe("inMemoryUsageMeter", () => {
  it("records cost by source, model, and in the total; evaluations default to 0", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "judge", "opus", { usd: 0.02, tokens: 50 });
    const u = meter.usage("acme");
    expect(u).toMatchObject({ usd: 0.02, tokens: 50, evaluations: 0 });
    expect(u.bySource.judge).toMatchObject({ usd: 0.02, tokens: 50, evaluations: 0 });
    expect(u.bySource.harness).toMatchObject({ usd: 0, tokens: 0, evaluations: 0 });
    expect(u.bySource.agent).toMatchObject({ usd: 0, tokens: 0, evaluations: 0 });
  });

  it("itemizes per (source × model) — same model under two sources are distinct lines", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1);
    meter.record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1); // same line accumulates
    meter.record("acme", "harness", "haiku", { usd: 0.02, tokens: 40 }, 1);
    meter.record("acme", "agent", "opus", { usd: 0.5, tokens: 500 });
    const items = meter.usage("acme").items;
    expect(items).toContainEqual({ source: "harness", model: "opus", usd: 0.2, tokens: 200, evaluations: 2 });
    expect(items).toContainEqual({ source: "harness", model: "haiku", usd: 0.02, tokens: 40, evaluations: 1 });
    expect(items).toContainEqual({ source: "agent", model: "opus", usd: 0.5, tokens: 500, evaluations: 0 });
  });

  it("sums every line into the total and the per-source split", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1);
    meter.record("acme", "judge", "opus", { usd: 0.03, tokens: 30 });
    meter.record("acme", "agent", "haiku", { usd: 0.5, tokens: 500 });
    const u = meter.usage("acme");
    expect(u).toMatchObject({ usd: 0.63, tokens: 630, evaluations: 1 });
    expect(u.bySource.harness).toMatchObject({ usd: 0.1, tokens: 100, evaluations: 1 });
    expect(u.bySource.judge).toMatchObject({ usd: 0.03, tokens: 30, evaluations: 0 });
    expect(u.bySource.agent).toMatchObject({ usd: 0.5, tokens: 500, evaluations: 0 });
  });

  it("accumulates a (day × source × model) series — same line same day merges, days split", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "harness", "opus", { usd: 0.25, tokens: 100 }, 1, "2026-07-27");
    meter.record("acme", "harness", "opus", { usd: 0.5, tokens: 200 }, 1, "2026-07-27"); // same day+line accumulates
    meter.record("acme", "harness", "opus", { usd: 0.4, tokens: 400 }, 2, "2026-07-28"); // next day → its own line
    meter.record("acme", "judge", "opus", { usd: 0.03, tokens: 30 }, 0, "2026-07-27");
    const daily = meter.usage("acme").daily;
    expect(daily).toEqual([
      { day: "2026-07-27", source: "harness", model: "opus", usd: 0.75, tokens: 300, evaluations: 2 },
      { day: "2026-07-27", source: "judge", model: "opus", usd: 0.03, tokens: 30, evaluations: 0 },
      { day: "2026-07-28", source: "harness", model: "opus", usd: 0.4, tokens: 400, evaluations: 2 },
    ]);
  });

  it("stamps today's UTC day when the caller omits it", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "agent", "haiku", { usd: 0.01, tokens: 10 });
    const daily = meter.usage("acme").daily;
    expect(daily).toHaveLength(1);
    expect(daily[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps the pre-itemization legacy bucket in the totals but out of the daily series", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "harness", "", { usd: 5, tokens: 5000 }, 10, "1970-01-01"); // hydrated legacy row
    meter.record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1, "2026-07-28");
    const u = meter.usage("acme");
    expect(u.usd).toBeCloseTo(5.1, 10);
    expect(u.evaluations).toBe(11);
    expect(u.daily).toEqual([
      { day: "2026-07-28", source: "harness", model: "opus", usd: 0.1, tokens: 100, evaluations: 1 },
    ]);
  });

  it("usage() returns an isolated snapshot — mutating it does not corrupt the meter", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "harness", "opus", { usd: 1, tokens: 10 }, 1);
    const snapshot = meter.usage("acme");
    snapshot.usd = 999;
    snapshot.bySource.harness.usd = 999;
    const item = snapshot.items[0];
    if (item) item.usd = 999;
    const dayLine = snapshot.daily[0];
    if (dayLine) dayLine.usd = 999;
    expect(meter.usage("acme").usd).toBe(1);
    expect(meter.usage("acme").bySource.harness.usd).toBe(1);
    expect(meter.usage("acme").items[0]?.usd).toBe(1);
    expect(meter.usage("acme").daily[0]?.usd).toBe(1);
  });
});

describe("totalUsage", () => {
  it("sums metered usage across tenants (operator rollup)", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1);
    meter.record("beta", "harness", "opus", { usd: 0.4, tokens: 400 }, 1);
    expect(totalUsage(meter, ["acme", "beta"])).toEqual({ usd: 0.5, tokens: 500, evaluations: 2 });
  });
});
