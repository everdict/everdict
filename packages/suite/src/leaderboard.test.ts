import { describe, expect, it } from "vitest";
import { type LeaderboardCard, leaderboard } from "./leaderboard.js";

// 한 데이터셋의 스코어카드. judge passRate 를 metric 으로 랭킹한다.
const card = (
  id: string,
  harness: { id: string; version: string },
  model: string | undefined,
  passRate: number | null,
  extra: Partial<LeaderboardCard> = {},
): LeaderboardCard => ({
  id,
  dataset: { id: "pinch-core", version: "1.0.0" },
  harness,
  status: "succeeded",
  createdAt: `2026-06-0${id.length}T00:00:00Z`,
  summary: passRate === null ? [] : [{ metric: "judge", count: 10, mean: passRate, passRate }],
  ...(model ? { models: { observed: [model], primary: model } } : {}),
  ...extra,
});

const H_A = { id: "codex", version: "1.0.0" };
const H_B = { id: "claude-code", version: "1.0.0" };

describe("leaderboard", () => {
  it("한 데이터셋 위 (harness × model) 을 metric 내림차순으로 랭킹 + rank 부여", () => {
    const lb = leaderboard(
      [card("a", H_A, "gpt-5", 0.6), card("bb", H_B, "claude-opus-4-8", 0.9), card("ccc", H_A, "o3", 0.75)],
      { datasetId: "pinch-core", metric: "judge" },
    );
    expect(lb.rows.map((r) => [r.rank, r.harness.id, r.model, r.score])).toEqual([
      [1, "claude-code", "claude-opus-4-8", 0.9],
      [2, "codex", "o3", 0.75],
      [3, "codex", "gpt-5", 0.6],
    ]);
  });

  it("같은 harness@version 이라도 model 이 다르면 별도 행(model 축)", () => {
    const lb = leaderboard([card("a", H_A, "gpt-5", 0.6), card("bb", H_A, "o3", 0.8)], {
      datasetId: "pinch-core",
      metric: "judge",
    });
    expect(lb.rows).toHaveLength(2);
    expect(lb.rows.map((r) => r.model)).toEqual(["o3", "gpt-5"]);
  });

  it("같은 (harness×model) 의 여러 run 은 한 행으로 접힌다 — window=latest 는 최신 대표, runs 는 개수", () => {
    const lb = leaderboard(
      [
        card("a", H_A, "gpt-5", 0.5), // 2026-06-01
        card("bbb", H_A, "gpt-5", 0.9), // 2026-06-03 (최신)
      ],
      { datasetId: "pinch-core", metric: "judge" },
    );
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]?.runs).toBe(2);
    expect(lb.rows[0]?.score).toBe(0.9); // latest = 최신(2026-06-03)
    expect(lb.rows[0]?.scorecardId).toBe("bbb");
  });

  it("window=best 는 그룹의 최고 점수 run 을 대표로", () => {
    const lb = leaderboard([card("a", H_A, "gpt-5", 0.9), card("bbb", H_A, "gpt-5", 0.5)], {
      datasetId: "pinch-core",
      metric: "judge",
      window: "best",
    });
    expect(lb.rows[0]?.score).toBe(0.9);
    expect(lb.rows[0]?.scorecardId).toBe("a");
    expect(lb.window).toBe("best");
  });

  it("harness/model 필터 + 다른 dataset·미완료 제외", () => {
    const lb = leaderboard(
      [
        card("a", H_A, "gpt-5", 0.6),
        card("bb", H_B, "claude-opus-4-8", 0.9),
        card("ccc", H_A, "gpt-5", 0.7, { dataset: { id: "other", version: "1.0.0" } }), // 다른 dataset
        card("dddd", H_A, "gpt-5", 0.1, { status: "running" }), // 미완료
      ],
      { datasetId: "pinch-core", metric: "judge", harnessId: "codex", model: "gpt-5" },
    );
    expect(lb.rows.map((r) => r.harness.id)).toEqual(["codex"]);
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]?.score).toBe(0.6);
  });

  it("metric 이 없는 스코어카드는 score null → 랭킹 뒤로", () => {
    const lb = leaderboard([card("a", H_A, "gpt-5", null), card("bb", H_B, "o3", 0.5)], {
      datasetId: "pinch-core",
      metric: "judge",
    });
    expect(lb.rows.map((r) => r.harness.id)).toEqual(["claude-code", "codex"]); // null 은 뒤
    expect(lb.rows[1]?.score).toBeNull();
  });

  it("모델 미상(models 없음)도 harness 로 그룹핑되며 model 은 미설정(unknown)", () => {
    const lb = leaderboard([card("a", H_A, undefined, 0.6)], { datasetId: "pinch-core", metric: "judge" });
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]?.model).toBeUndefined();
  });
});
