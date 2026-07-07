import { describe, expect, it } from "vitest";
import { type LeaderboardCard, leaderboard } from "./leaderboard.js";

// Scorecards for one dataset. Ranks by judge passRate as the metric.
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
  it("ranks (harness × model) on one dataset by metric descending + assigns rank", () => {
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

  it("different models under the same harness@version get separate rows (model axis)", () => {
    const lb = leaderboard([card("a", H_A, "gpt-5", 0.6), card("bb", H_A, "o3", 0.8)], {
      datasetId: "pinch-core",
      metric: "judge",
    });
    expect(lb.rows).toHaveLength(2);
    expect(lb.rows.map((r) => r.model)).toEqual(["o3", "gpt-5"]);
  });

  it("multiple runs of the same (harness×model) fold into one row — window=latest picks the newest representative, runs is the count", () => {
    const lb = leaderboard(
      [
        card("a", H_A, "gpt-5", 0.5), // 2026-06-01
        card("bbb", H_A, "gpt-5", 0.9), // 2026-06-03 (newest)
      ],
      { datasetId: "pinch-core", metric: "judge" },
    );
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]?.runs).toBe(2);
    expect(lb.rows[0]?.score).toBe(0.9); // latest = newest (2026-06-03)
    expect(lb.rows[0]?.scorecardId).toBe("bbb");
  });

  it("window=best picks the group's highest-score run as the representative", () => {
    const lb = leaderboard([card("a", H_A, "gpt-5", 0.9), card("bbb", H_A, "gpt-5", 0.5)], {
      datasetId: "pinch-core",
      metric: "judge",
      window: "best",
    });
    expect(lb.rows[0]?.score).toBe(0.9);
    expect(lb.rows[0]?.scorecardId).toBe("a");
    expect(lb.window).toBe("best");
  });

  it("harness/model filter + excludes other datasets and incomplete", () => {
    const lb = leaderboard(
      [
        card("a", H_A, "gpt-5", 0.6),
        card("bb", H_B, "claude-opus-4-8", 0.9),
        card("ccc", H_A, "gpt-5", 0.7, { dataset: { id: "other", version: "1.0.0" } }), // different dataset
        card("dddd", H_A, "gpt-5", 0.1, { status: "running" }), // incomplete
      ],
      { datasetId: "pinch-core", metric: "judge", harnessId: "codex", model: "gpt-5" },
    );
    expect(lb.rows.map((r) => r.harness.id)).toEqual(["codex"]);
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]?.score).toBe(0.6);
  });

  it("a scorecard without the metric gets score null → ranked last", () => {
    const lb = leaderboard([card("a", H_A, "gpt-5", null), card("bb", H_B, "o3", 0.5)], {
      datasetId: "pinch-core",
      metric: "judge",
    });
    expect(lb.rows.map((r) => r.harness.id)).toEqual(["claude-code", "codex"]); // null last
    expect(lb.rows[1]?.score).toBeNull();
  });

  it("an unknown model (no models) still groups by harness with model unset (unknown)", () => {
    const lb = leaderboard([card("a", H_A, undefined, 0.6)], { datasetId: "pinch-core", metric: "judge" });
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]?.model).toBeUndefined();
  });

  it("judgeModel filter: only runs scored by that judge model (fair comparison among the same scorer) + exposes judgeModels on the row", () => {
    const lb = leaderboard(
      [
        card("a", H_A, "gpt-5", 0.6, { judgeModels: ["gpt-5.4-mini"] }),
        card("bb", H_B, "o3", 0.9, { judgeModels: ["claude-opus-4-8"] }), // different judge → excluded by the filter
      ],
      { datasetId: "pinch-core", metric: "judge", judgeModel: "gpt-5.4-mini" },
    );
    expect(lb.rows).toHaveLength(1);
    expect(lb.rows[0]?.harness.id).toBe("codex");
    expect(lb.rows[0]?.judgeModels).toEqual(["gpt-5.4-mini"]);
  });
});
