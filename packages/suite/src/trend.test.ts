import { describe, expect, it } from "vitest";
import { type TrendCard, trendSeries } from "./trend.js";

// 한 데이터셋의 시간순 스코어카드들(judge passRate 가 1.0 → 0.5 → 0.8 로 변동).
const card = (id: string, createdAt: string, passRate: number | null, extra: Partial<TrendCard> = {}): TrendCard => ({
  id,
  dataset: { id: "pinch-core", version: "1.0.0" },
  harness: { id: "hermes-desktop", version: "1.0.0" },
  status: "succeeded",
  createdAt,
  summary: passRate === null ? [] : [{ metric: "judge", count: 10, mean: passRate, passRate }],
  ...extra,
});

describe("trendSeries", () => {
  it("시간순 정렬 + first baseline 대비 delta/회귀 플래그", () => {
    const t = trendSeries(
      [
        card("b", "2026-06-02T00:00:00Z", 0.5), // 회귀(1.0 → 0.5)
        card("a", "2026-06-01T00:00:00Z", 1.0), // baseline(first)
        card("c", "2026-06-03T00:00:00Z", 0.8), // 여전히 baseline 미만 → 회귀
      ],
      { datasetId: "pinch-core", metric: "judge", baseline: "first" },
    );
    expect(t.points.map((p) => p.scorecardId)).toEqual(["a", "b", "c"]); // createdAt asc
    expect(t.points.map((p) => p.score)).toEqual([1.0, 0.5, 0.8]);
    expect(t.points.map((p) => p.deltaVsBaseline)).toEqual([0, -0.5, expect.closeTo(-0.2, 5)]);
    expect(t.points.map((p) => p.regressed)).toEqual([false, true, true]);
  });

  it("previous baseline: 각 포인트가 직전 대비 — c 는 0.5→0.8 이므로 회귀 아님", () => {
    const t = trendSeries(
      [
        card("a", "2026-06-01T00:00:00Z", 1.0),
        card("b", "2026-06-02T00:00:00Z", 0.5), // 직전(1.0) 대비 회귀
        card("c", "2026-06-03T00:00:00Z", 0.8), // 직전(0.5) 대비 개선
      ],
      { datasetId: "pinch-core", metric: "judge", baseline: "previous" },
    );
    expect(t.points.map((p) => p.regressed)).toEqual([false, true, false]);
    expect(t.points[2]?.deltaVsBaseline).toBeCloseTo(0.3, 5);
  });

  it("지정 baseline(scorecardId)", () => {
    const t = trendSeries([card("a", "2026-06-01T00:00:00Z", 1.0), card("b", "2026-06-02T00:00:00Z", 0.5)], {
      datasetId: "pinch-core",
      metric: "judge",
      baseline: "b",
    });
    expect(t.points.find((p) => p.scorecardId === "a")?.deltaVsBaseline).toBeCloseTo(0.5, 5);
    expect(t.points.find((p) => p.scorecardId === "a")?.regressed).toBe(false);
  });

  it("dataset/harness/날짜/상태 필터 + 메트릭 없으면 score null(회귀 아님)", () => {
    const t = trendSeries(
      [
        card("a", "2026-06-01T00:00:00Z", 1.0),
        card("other", "2026-06-02T00:00:00Z", 0.1, { dataset: { id: "another", version: "1.0.0" } }), // 다른 dataset
        card("running", "2026-06-02T00:00:00Z", 0.1, { status: "running" }), // 미완료
        card("nometric", "2026-06-03T00:00:00Z", null), // 메트릭 없음
      ],
      { datasetId: "pinch-core", metric: "judge", from: "2026-06-01T00:00:00Z", to: "2026-06-05T00:00:00Z" },
    );
    expect(t.points.map((p) => p.scorecardId)).toEqual(["a", "nometric"]);
    expect(t.points[1]?.score).toBeNull();
    expect(t.points[1]?.regressed).toBe(false);
  });

  it("passRate 없으면 mean 을 score 로 사용", () => {
    const c: TrendCard = {
      id: "x",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      createdAt: "2026-06-01T00:00:00Z",
      summary: [{ metric: "cost", count: 1, mean: 0.42 }], // passRate 없음
    };
    const t = trendSeries([c], { datasetId: "d", metric: "cost" });
    expect(t.points[0]?.score).toBe(0.42);
    expect(t.points[0]?.passRate).toBeNull();
  });
});
