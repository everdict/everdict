import type { CaseResult, Dataset, GradeContext, JudgeRunConfig, JudgeSpec, MetricSpec, Placement } from "@assay/core";
import type { JudgeRegistry, MetricRegistry } from "@assay/registry";
import { evalMetric } from "@assay/suite";
import type { JudgeRunner } from "./judge-runner.js";

// 채점(Scoring) 관심사 — 결과(트레이스) 위의 순수한 평가: judge 적용 · metric 적용 · judge 모델 수집.
// 실행과 독립적이다: 라이브 배치의 산출 결과든, ingest 로 외부에서 당겨온 트레이스든 동일하게 채점한다.
// (집계 summary/diff/leaderboard 는 이미 @assay/suite 의 순수 함수 — 여기선 judge/metric '적용'만 담당.)
// docs/architecture/execution-scoring-orchestration.md
export interface ScoringServiceDeps {
  judges?: JudgeRegistry; // judge 해석(소유/_shared 폴백)
  metrics?: MetricRegistry; // 등록 metric 해석(소유/_shared 폴백)
  judgeRunner?: JudgeRunner; // 트레이스 기반 judge 실행(model 호출 / harness 디스패치 / skip)
}

export class ScoringService {
  constructor(private readonly deps: ScoringServiceDeps) {}

  // 선택된 judge 들을 각 케이스 트레이스에 적용 → judge:<id> 점수를 결과 scores 에 덧붙인다(요약에 반영).
  // 없는 judge 는 스킵; judge/runner 미설정이면 no-op(judge 미선택과 동일).
  async applyJudges(
    tenant: string,
    dataset: Dataset,
    results: CaseResult[],
    judges: Array<{ id: string; version: string }>,
    runtime?: string, // 산출 run 의 런타임(co-locate 용). ingest 경로는 산출 run 이 없어 undefined.
  ): Promise<void> {
    if (judges.length === 0 || !this.deps.judges || !this.deps.judgeRunner) return;
    const registry = this.deps.judges;
    const runner = this.deps.judgeRunner;
    const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
    for (const sel of judges) {
      let spec: JudgeSpec;
      try {
        spec = await registry.get(tenant, sel.id, sel.version || "latest");
      } catch {
        continue; // 없는 judge 는 조용히 스킵
      }
      for (const result of results) {
        const evalCase = caseById.get(result.caseId);
        if (!evalCase) continue;
        // 산출 run 의 placement 재구성: runtime 선택 시 target 으로 덮어쓴다.
        // harness judge 는 spec.runtime 이 없으면 이걸 상속해 관측물 옆에서 판정(co-locate).
        const runPlacement: Placement | undefined = runtime
          ? { ...evalCase.placement, target: runtime }
          : evalCase.placement;
        const ctx: GradeContext = { case: evalCase, trace: result.trace, snapshot: result.snapshot };
        result.scores.push(await runner.run(spec, tenant, ctx, runPlacement));
      }
    }
  }

  // 선택된 등록 Metric 들을 각 케이스의 *이미 산출된 scores* 위에 적용 → 새 합격규칙 점수를 덧붙인다(요약/트렌드에 반영).
  // judge 적용 뒤에 호출 → judge:<id> 점수에도 임계를 걸 수 있다. 없는 metric/누락 source 는 조용히 스킵.
  async applyMetrics(
    tenant: string,
    results: CaseResult[],
    metrics: Array<{ id: string; version: string }>,
  ): Promise<void> {
    if (metrics.length === 0 || !this.deps.metrics) return;
    const registry = this.deps.metrics;
    for (const sel of metrics) {
      let spec: MetricSpec;
      try {
        spec = await registry.get(tenant, sel.id, sel.version || "latest");
      } catch {
        continue; // 없는 metric 은 조용히 스킵
      }
      for (const result of results) {
        const score = evalMetric(spec, result.scores);
        if (score) result.scores.push(score);
      }
    }
  }

  // 이 채점에 쓰인 judge 모델(들) — inline judge config.model + 등록 model-judge spec.model 의 distinct(정렬).
  // 리더보드 judge 축(공정 비교: 같은 judge)의 필터/표시용. harness judge 는 model 이 없으니 제외.
  async collectJudgeModels(
    tenant: string,
    judges: Array<{ id: string; version: string }>,
    inlineJudge: JudgeRunConfig | undefined,
  ): Promise<string[]> {
    const models = new Set<string>();
    if (inlineJudge?.model) models.add(inlineJudge.model);
    if (this.deps.judges) {
      for (const sel of judges) {
        try {
          const spec = await this.deps.judges.get(tenant, sel.id, sel.version || "latest");
          if (spec.kind === "model") models.add(spec.model);
        } catch {
          // 없는 judge 는 스킵(applyJudges 와 동일)
        }
      }
    }
    return [...models].sort();
  }
}
