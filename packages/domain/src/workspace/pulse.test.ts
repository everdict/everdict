import { PLATFORM_EVENT_KINDS, activityAxisOf } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { activityTrend, calendarSpan, flowTrend, meanPassRate, qualityTrend, weightedMeanPassRate } from "./pulse.js";

describe("the activity axis vocabulary", () => {
  it("places every recorded event kind on exactly one axis", () => {
    const unplaced = PLATFORM_EVENT_KINDS.filter((kind) => activityAxisOf(kind) === undefined);
    expect(unplaced).toEqual([]);
  });

  it("has no axis for a kind this deployment does not know", () => {
    expect(activityAxisOf("something.invented_later")).toBeUndefined();
  });
});

describe("the calendar spine", () => {
  it("includes both ends", () => {
    expect(calendarSpan("2026-08-01", "2026-08-04")).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);
  });

  it("is empty when the window runs backwards", () => {
    expect(calendarSpan("2026-08-04", "2026-08-01")).toEqual([]);
  });
});

describe("the activity trend", () => {
  const days = calendarSpan("2026-08-01", "2026-08-03");

  it("keeps a quiet day as a zero rather than skipping it", () => {
    const points = activityTrend([{ day: "2026-08-01", kind: "issue.created", count: 2 }], days);
    expect(points.map((p) => p.date)).toEqual(days);
    expect(points[1]).toEqual({ date: "2026-08-02", work: 0, evaluation: 0, agent: 0, knowledge: 0, total: 0 });
  });

  it("splits a day's facts across the axes and carries the total", () => {
    const points = activityTrend(
      [
        { day: "2026-08-02", kind: "issue.created", count: 3 },
        { day: "2026-08-02", kind: "scorecard.completed", count: 1 },
        { day: "2026-08-02", kind: "agent.run.completed", count: 4 },
        { day: "2026-08-02", kind: "file.published", count: 2 },
      ],
      days,
    );
    expect(points[1]).toEqual({ date: "2026-08-02", work: 3, evaluation: 1, agent: 4, knowledge: 2, total: 10 });
  });

  it("drops a kind it cannot place instead of inventing a band", () => {
    const points = activityTrend([{ day: "2026-08-01", kind: "something.invented_later", count: 9 }], days);
    expect(points[0]?.total).toBe(0);
  });

  it("ignores a bucket outside the window", () => {
    const points = activityTrend([{ day: "2026-07-30", kind: "issue.created", count: 5 }], days);
    expect(points.every((p) => p.total === 0)).toBe(true);
  });
});

describe("the work flow trend", () => {
  const days = calendarSpan("2026-08-01", "2026-08-02");

  it("counts arrivals from created facts and departures from the transition's destination", () => {
    const points = flowTrend(
      [
        { day: "2026-08-01", kind: "issue.created", count: 4 },
        { day: "2026-08-01", kind: "issue.status_changed", outcome: "done", count: 2 },
        { day: "2026-08-01", kind: "issue.status_changed", outcome: "in_progress", count: 7 },
      ],
      days,
    );
    expect(points[0]).toEqual({ date: "2026-08-01", created: 4, completed: 2 });
  });

  it("counts a cancellation as work leaving the board", () => {
    const points = flowTrend(
      [{ day: "2026-08-02", kind: "issue.status_changed", outcome: "cancelled", count: 3 }],
      days,
    );
    expect(points[1]?.completed).toBe(3);
  });

  it("does not count a regression as a departure — it is work back in flight", () => {
    const points = flowTrend(
      [{ day: "2026-08-02", kind: "issue.status_changed", outcome: "regressed", count: 2 }],
      days,
    );
    expect(points[1]?.completed).toBe(0);
  });

  it("drops a transition recorded with a status it cannot read", () => {
    const points = flowTrend([{ day: "2026-08-01", kind: "issue.status_changed", outcome: "shipped", count: 5 }], days);
    expect(points[0]?.completed).toBe(0);
  });
});

describe("the quality trend", () => {
  const days = calendarSpan("2026-08-01", "2026-08-03");

  it("leaves the pass rate ABSENT on a day nobody measured", () => {
    const points = qualityTrend([{ day: "2026-08-01", passRate: 0.5 }], days);
    expect(points[1]).toEqual({ date: "2026-08-02", scorecards: 0 });
    expect(points[1]).not.toHaveProperty("passRate");
  });

  it("counts a batch that reported no rate but does not let it drag the mean to zero", () => {
    const points = qualityTrend([{ day: "2026-08-03", passRate: 0.8 }, { day: "2026-08-03" }], days);
    expect(points[2]).toEqual({ date: "2026-08-03", scorecards: 2, passRate: 0.8 });
  });
});

describe("the window's headline pass rate", () => {
  it("is the mean of what was reported", () => {
    expect(meanPassRate([0.5, 1])).toBe(0.75);
  });

  it("is absent when nothing was", () => {
    expect(meanPassRate([])).toBeUndefined();
  });
});

describe("weightedMeanPassRate", () => {
  it("weights by case count — a 3-case smoke run cannot move the headline like a 500-case suite", () => {
    const rates = [
      { rate: 1.0, weight: 3 }, // tiny smoke run, perfect
      { rate: 0.5, weight: 497 }, // the real suite
    ];
    const weighted = weightedMeanPassRate(rates);
    expect(weighted).toBeCloseTo((1.0 * 3 + 0.5 * 497) / 500, 5); // ≈ 0.503, not the plain-mean 0.75
    expect(weightedMeanPassRate([])).toBeUndefined();
  });
});
