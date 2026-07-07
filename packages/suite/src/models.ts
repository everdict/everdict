import type { Scorecard } from "@everdict/core";

// 스코어카드가 실제로 쓴 모델 — 리더보드의 model 축. 관측(트레이스) 우선 + 선언(spec) 폴백, 둘 다 보존.
// observed = 트레이스 llm_call.model 의 distinct(정렬); declared = spec 선언(CommandHarnessSpec.model);
// primary = 리더보드 그룹 키(최빈 관측 → 동률이면 사전순 첫값 → 관측 없으면 declared → 둘 다 없으면 미설정=unknown).
export interface ScorecardModels {
  observed: string[];
  declared?: string;
  primary?: string;
}

// sc 의 모든 케이스 트레이스에서 llm_call.model 을 모아 관측 모델 집합/최빈값을 낸다. declared 는 선언 폴백.
export function scorecardModels(sc: Scorecard, declared?: string): ScorecardModels {
  const counts = new Map<string, number>();
  for (const result of sc.results) {
    for (const e of result.trace) {
      if (e.kind !== "llm_call" || e.model === "") continue;
      counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
    }
  }
  const observed = [...counts.keys()].sort();
  // 최빈 관측 — observed 가 사전순 정렬이라 동률 시 첫 순회값(사전순 첫값)이 이겨 결정적.
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
  const resolved = primary ?? dec; // 관측 우선, 없으면 선언 폴백
  if (resolved) models.primary = resolved;
  return models;
}
