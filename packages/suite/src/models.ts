import type { Scorecard } from "@everdict/core";

// The models the scorecard actually used — the leaderboard's model axis. Observed (trace) first + declared (spec) fallback, both preserved.
// observed = distinct (sorted) trace llm_call.model; declared = the spec declaration (CommandHarnessSpec.model);
// primary = the leaderboard group key (most-frequent observed → lexicographically first on a tie → declared if no observation → unset=unknown if neither).
export interface ScorecardModels {
  observed: string[];
  declared?: string;
  primary?: string;
}

// Gathers llm_call.model across all of sc's case traces to produce the observed model set/mode. declared is the declaration fallback.
export function scorecardModels(sc: Scorecard, declared?: string): ScorecardModels {
  const counts = new Map<string, number>();
  for (const result of sc.results) {
    for (const e of result.trace) {
      if (e.kind !== "llm_call" || e.model === "") continue;
      counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
    }
  }
  const observed = [...counts.keys()].sort();
  // Most-frequent observed — since observed is lexicographically sorted, on a tie the first iterated value (lexicographically first) wins, so it's deterministic.
  let primary: string | undefined;
  let best = 0;
  for (const model of observed) {
    const c = counts.get(model) ?? 0;
    if (c > best) {
      best = c;
      primary = model;
    }
  }
  const dec = declared && declared !== "" ? declared : undefined;
  const models: ScorecardModels = { observed };
  if (dec) models.declared = dec;
  const resolved = primary ?? dec; // observed first, declared fallback if absent
  if (resolved) models.primary = resolved;
  return models;
}
