import { metricMatches } from "@everdict/contracts";
import type { MetricSummary } from "./scorecard.js";
import { DEFAULT_VERDICT_POLICY, verdictPolicyIdentity } from "./verdict-policy.js";

// Leaderboard input card — the same *lightweight* shape as trendSeries (@everdict/db ScorecardRecord satisfies it structurally; suite does not depend on db).
// models is the model(s) this run used (one axis of the leaderboard group key). Where trendSeries lays one harness out along the time axis,
// this ranks (harness × model) by score on a single dataset (benchmark).
export interface LeaderboardCard {
  id: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string };
  status: string;
  createdAt: string; // ISO
  summary?: MetricSummary[];
  // Which policy judged this batch (absent = pre-stamp, the frozen v1 ladder). id+version ride along so the
  // identity comparison resolves known documents instead of comparing raw digest strings across eras.
  verdictPolicy?: { id: string; version: string; digest: string };
  models?: { observed?: string[]; declared?: string; primary?: string };
  judgeModels?: string[]; // The judge model(s) that scored this run — filter/display axis for fair comparison (same judge)
}

export interface LeaderboardRow {
  rank: number; // 1-based, score descending
  harness: { id: string; version: string };
  model?: string; // models.primary (group key). Unset → the unknown group.
  // TRUE when this row's runs recorded no model — distinct unknown models may be folded together here, so a
  // fair comparison against a named-model row does not hold. The UI labels it; filters never match it.
  modelUnknown?: boolean;
  judgeModels?: string[]; // The judge model(s) that scored the representative run — for checking whether the comparison is fair
  scorecardId: string; // The representative scorecard (window policy)
  createdAt: string;
  score: number | null; // passRate first (mean if absent) — the ranking key
  passRate: number | null;
  mean: number | null;
  runs: number; // Number of scorecards folded into this (harness×model) group
}

export interface Leaderboard {
  dataset: string; // datasetId
  metric: string;
  window: "latest" | "best";
  // TRUE when the ranked batches were judged under different verdict policies — the rows' rates were produced
  // by different rules, so the ordering is disclosed as cross-policy rather than silently mixed.
  policyMixed?: boolean;
  rows: LeaderboardRow[]; // score descending (null last)
}

interface Scored {
  card: LeaderboardCard;
  mean: number | null;
  passRate: number | null;
  score: number | null;
}

const GROUP_SEP = ""; // Separator that safely joins harness@version and model (does not appear in identifiers)

// direction-aware "better" (null always loses). sign +1 = higher is better, -1 = lower is better —
// ranking cost_usd score-descending crowned the most EXPENSIVE harness. On a tie, newest createdAt wins.
function betterRep(a: Scored, b: Scored, sign: 1 | -1): Scored {
  const as = a.score;
  const bs = b.score;
  if (as !== bs) {
    if (as === null) return b;
    if (bs === null) return a;
    return sign * (as - bs) > 0 ? a : b;
  }
  return a.card.createdAt >= b.card.createdAt ? a : b;
}

// Reading direction for the ranking metric: policy-declared, else pass-rate series are higher-is-better.
// An unknown-direction mean series still ranks descending (the historical read), but the direction rides the
// result so a consumer can label the order honestly.
function rankSign(metric: string, usesPassRate: boolean): 1 | -1 {
  const declared = DEFAULT_VERDICT_POLICY.metrics.find((d) => metricMatches(d.match, metric))?.direction;
  if (declared === "lower_is_better") return -1;
  if (declared === "higher_is_better" || usesPassRate) return 1;
  return 1;
}

// Groups a dataset's scorecards by (harness × models.primary) and ranks them by the metric score.
// window=latest (default): the group's representative = newest createdAt; window=best: representative = highest score (newest on a tie).
export function leaderboard(
  cards: LeaderboardCard[],
  opts: {
    datasetId: string;
    metric: string;
    harnessId?: string;
    model?: string;
    judgeModel?: string; // When set, only runs scored by that judge model (fair comparison among the same scorer)
    window?: "latest" | "best";
  },
): Leaderboard {
  const window = opts.window ?? "latest";
  const scored = cards
    .filter((c) => c.status === "succeeded")
    .filter((c) => c.dataset.id === opts.datasetId)
    .filter((c) => !opts.harnessId || c.harness.id === opts.harnessId)
    .filter((c) => !opts.model || (c.models?.primary ?? "") === opts.model)
    .filter((c) => !opts.judgeModel || (c.judgeModels ?? []).includes(opts.judgeModel))
    .map((c): Scored => {
      const m = c.summary?.find((s) => s.metric === opts.metric);
      const passRate = m?.passRate ?? null;
      // An annihilated metric (count 0 — mean absent) contributes NO score: a dead grader must never rank,
      // let alone rank FIRST on a lower-is-better axis.
      const mean = m?.mean ?? null;
      return { card: c, mean, passRate, score: passRate ?? mean };
    });

  const sign = rankSign(
    opts.metric,
    scored.some((s) => s.passRate !== null),
  );

  // (harness@version × model.primary) group → representative card + folded count.
  const groups = new Map<string, { rep: Scored; runs: number }>();
  for (const s of scored) {
    const key = `${s.card.harness.id}@${s.card.harness.version}${GROUP_SEP}${s.card.models?.primary ?? ""}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { rep: s, runs: 1 });
      continue;
    }
    g.runs += 1;
    // latest = newest createdAt, best = betterRep (highest score, newest on a tie).
    g.rep = window === "best" ? betterRep(g.rep, s, sign) : g.rep.card.createdAt >= s.card.createdAt ? g.rep : s;
  }

  const rows = [...groups.values()]
    .map(({ rep, runs }): Omit<LeaderboardRow, "rank"> => {
      const primary = rep.card.models?.primary;
      const judgeModels = rep.card.judgeModels;
      return {
        harness: rep.card.harness,
        ...(primary ? { model: primary } : { modelUnknown: true }),
        ...(judgeModels && judgeModels.length > 0 ? { judgeModels } : {}),
        scorecardId: rep.card.id,
        createdAt: rep.card.createdAt,
        score: rep.score,
        passRate: rep.passRate,
        mean: rep.mean,
        runs,
      };
    })
    .sort((a, b) => {
      if (a.score !== b.score) {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return sign * (b.score - a.score); // rank 1 = BEST under the metric's declared direction
      }
      const t = b.createdAt.localeCompare(a.createdAt); // newest first
      if (t !== 0) return t;
      return a.harness.id.localeCompare(b.harness.id); // deterministic tie-break
    })
    .map((r, i) => ({ rank: i + 1, ...r }));

  // Semantic identity, never the raw stamp: FNV-era and sha256-era stamps of one document (and unstamped
  // pre-mig cards judged under the same frozen v1 ladder) are ONE rule-set, not a mixed board.
  const policyMixed = new Set(scored.map((s) => verdictPolicyIdentity(s.card.verdictPolicy))).size > 1;
  return { dataset: opts.datasetId, metric: opts.metric, window, ...(policyMixed ? { policyMixed } : {}), rows };
}
