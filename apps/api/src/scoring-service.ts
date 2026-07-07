import type { CaseResult, Dataset, EvalCase, GradeContext, JudgeRunConfig, JudgeSpec, Placement } from "@assay/core";
import type { JudgeRegistry } from "@assay/registry";
import { createLimiter } from "./concurrency.js";
import type { JudgeRunner } from "./judge-runner.js";

// 채점(Scoring) 관심사 — 결과(트레이스) 위의 순수한 평가: judge 적용 · judge 모델 수집.
// 실행과 독립적이다: 라이브 배치의 산출 결과든, ingest 로 외부에서 당겨온 트레이스든 동일하게 채점한다.
// (집계 summary/diff/leaderboard 는 이미 @assay/suite 의 순수 함수 — 여기선 judge '적용'만 담당.)
// judge 적용은 케이스 단위로 스트리밍한다(케이스 완료 즉시 발사, 케이스 축 병렬·케이스 내 순서 결정적)
// — docs/architecture/streaming-case-pipeline.md + execution-scoring-orchestration.md
export interface ScoringServiceDeps {
  judges?: JudgeRegistry; // judge 해석(소유/_shared 폴백)
  judgeRunner?: JudgeRunner; // 트레이스 기반 judge 실행(model 호출 / harness 디스패치 / skip)
  caseConcurrency?: number; // 케이스 축 judge 동시 실행 상한(기본 4) — 프로바이더 rate-limit 보호
}

// 케이스 스트리밍 채점 핸들 — push 는 bounded 태스크를 발사하고 '그 케이스'의 judge 완료 시 resolve 되는
// Promise 를 돌려준다(후속 스테이지 체이닝용 — 예: 케이스 완성 즉시 싱크 export). 태스크 에러는 push 의
// Promise 로는 새지 않고 settle 이 첫 에러를 rethrow 한다(전 태스크 합류).
export interface JudgeStream {
  push(result: CaseResult): Promise<void>;
  settle(): Promise<void>;
}

const NOOP_STREAM: JudgeStream = { push: async () => {}, settle: async () => {} };

export class ScoringService {
  constructor(private readonly deps: ScoringServiceDeps) {}

  // 선택된 judge 들을 선(先)해석 — 케이스마다 레지스트리를 재조회하지 않도록. 없는 judge 는 여기서 스킵(조용히).
  async resolveJudges(tenant: string, judges: Array<{ id: string; version: string }>): Promise<JudgeSpec[]> {
    if (judges.length === 0 || !this.deps.judges || !this.deps.judgeRunner) return [];
    const specs: JudgeSpec[] = [];
    for (const sel of judges) {
      try {
        specs.push(await this.deps.judges.get(tenant, sel.id, sel.version || "latest"));
      } catch {
        // 없는 judge 는 조용히 스킵
      }
    }
    return specs;
  }

  // 한 케이스에 해석된 judge 들을 순서대로 적용 — 케이스 내 점수 순서는 결정적(선택 순서), 병렬화는 케이스 축에서만.
  async applyJudgesToCase(
    tenant: string,
    evalCase: EvalCase,
    specs: JudgeSpec[],
    result: CaseResult,
    runtime?: string, // 산출 run 의 런타임(co-locate 용). ingest 경로는 산출 run 이 없어 undefined.
  ): Promise<void> {
    const runner = this.deps.judgeRunner;
    if (!runner) return;
    // 산출 run 의 placement 재구성: runtime 선택 시 target 으로 덮어쓴다.
    // harness judge 는 spec.runtime 이 없으면 이걸 상속해 관측물 옆에서 판정(co-locate).
    const runPlacement: Placement | undefined = runtime
      ? { ...evalCase.placement, target: runtime }
      : evalCase.placement;
    const ctx: GradeContext = { case: evalCase, trace: result.trace, snapshot: result.snapshot };
    for (const spec of specs) {
      result.scores.push(await runner.run(spec, tenant, ctx, runPlacement));
    }
  }

  // 케이스 스트리밍 채점 — 케이스가 완료되는 즉시 judge 적용을 시작한다(배치 전체 완료를 기다리는 배리어 제거).
  // judge 미선택/미설정이면 no-op 스트림(push 무시, settle 즉시 완료).
  async createJudgeStream(
    tenant: string,
    dataset: Dataset,
    judges: Array<{ id: string; version: string }>,
    runtime?: string,
  ): Promise<JudgeStream> {
    const specs = await this.resolveJudges(tenant, judges);
    if (specs.length === 0) return NOOP_STREAM;
    const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
    const limit = createLimiter(this.deps.caseConcurrency ?? 4);
    const tasks: Array<Promise<void>> = [];
    let firstError: unknown;
    return {
      push: (result) => {
        const evalCase = caseById.get(result.caseId);
        if (!evalCase) return Promise.resolve(); // 데이터셋에 없는 caseId 는 스킵(정렬 불가)
        const task = limit(() => this.applyJudgesToCase(tenant, evalCase, specs, result, runtime)).catch((err) => {
          // 태스크는 발사 시점에 잡아둔다(unhandled rejection 방지) — settle 에서 첫 에러를 다시 던진다.
          firstError ??= err;
        });
        tasks.push(task);
        return task; // 이 케이스의 judge 완료 신호(에러는 삼켜짐 — 체이닝 스테이지는 완료만 기다린다)
      },
      settle: async () => {
        await Promise.all(tasks);
        if (firstError !== undefined) throw firstError;
      },
    };
  }

  // 선택된 judge 들을 각 케이스 트레이스에 적용 → judge:<id> 점수를 결과 scores 에 덧붙인다(요약에 반영).
  // 일괄 소비형(ingest 등 결과가 이미 다 있는 경로) — 내부적으로 스트림에 전부 push 후 합류(케이스 축 병렬).
  async applyJudges(
    tenant: string,
    dataset: Dataset,
    results: CaseResult[],
    judges: Array<{ id: string; version: string }>,
    runtime?: string,
  ): Promise<void> {
    const stream = await this.createJudgeStream(tenant, dataset, judges, runtime);
    for (const result of results) stream.push(result);
    await stream.settle();
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
