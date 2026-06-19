import { type BudgetTracker, type Dispatcher, costOf } from "@assay/backends";
import {
  type AgentJob,
  AppError,
  BadRequestError,
  type CaseResult,
  type Dataset,
  EnvSnapshotSchema,
  type GradeContext,
  type HarnessSpec,
  type JudgeSpec,
  NotFoundError,
  ScoreSchema,
  type Scorecard,
  type Suite,
  TraceEventSchema,
} from "@assay/core";
import type { ScorecardRecord, ScorecardStore } from "@assay/db";
import { costGrader, latencyGrader, stepsGrader } from "@assay/graders";
import type { DatasetRegistry, HarnessRegistry, JudgeRegistry } from "@assay/registry";
import { type Dispatch, type ScorecardDiff, diffScorecards, runSuite, summarizeScorecard } from "@assay/suite";
import { z } from "zod";
import type { JudgeRunner } from "./judge-runner.js";

// 트레이스 인제스트 본문 — 하니스를 안 돌리고 외부에서 이미 수행한 트레이스를 올린다(엣지 정규화: TraceEvent[] 업로드).
// dataset/harness 는 라벨 겸 ref(caseId↔task 정렬, diff 정렬). 경계에서 TraceEventSchema 로 검증.
export const IngestScorecardBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  traces: z
    .array(
      z.object({
        caseId: z.string(),
        trace: z.array(TraceEventSchema),
        snapshot: EnvSnapshotSchema.optional(),
        scores: z.array(ScoreSchema).optional(),
      }),
    )
    .min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type IngestScorecardBody = z.infer<typeof IngestScorecardBodySchema>;
export type IngestScorecardInput = IngestScorecardBody & { tenant: string };

export interface RunScorecardInput {
  tenant: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string };
  judges?: Array<{ id: string; version: string }>; // 선택한 Agent Judge 들 — 트레이스에 적용
  runtime?: string; // 실행할 테넌트 Runtime id(placement.target). 없으면 기본 백엔드.
}

export interface ScorecardServiceDeps {
  dispatcher: Dispatcher; // 케이스를 잡으로 디스패치(단일 run 과 동일 경로)
  store: ScorecardStore;
  datasets: DatasetRegistry; // 데이터셋 해석(소유/_shared 폴백) + 케이스 로드
  harnesses?: HarnessRegistry; // 하니스 버전 해석(latest→구체) + spec 임베드(선언형). 빌트인은 폴백.
  judges?: JudgeRegistry; // judge 해석(소유/_shared 폴백)
  judgeRunner?: JudgeRunner; // 트레이스 기반 judge 실행(model 호출 / skip)
  budget?: BudgetTracker; // 케이스마다 admission/settle
  concurrency?: number;
  newId?: () => string;
  now?: () => string;
}

// 스코어카드 run 의 비동기 수명: 데이터셋 해석(없으면 404) → 레코드 생성(202) → 배치 실행(runSuite) → 집계 저장.
// HTTP 와 무관하게 단위 테스트 가능. AppError 는 그대로 던져 호출부(서버)가 상태코드로 매핑한다.
export class ScorecardService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly concurrency: number;

  constructor(private readonly deps: ScorecardServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.concurrency = deps.concurrency ?? 4;
  }

  // 데이터셋을 동기 해석(NotFound→404), 하니스 버전/spec 해석 후 레코드 생성, 비동기 배치 실행.
  async submit(input: RunScorecardInput): Promise<ScorecardRecord> {
    const dataset = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");

    // 하니스 버전 해석(latest→구체) + 선언형 spec 임베드. 빌트인(scripted/claude-code)은 레지스트리에 없음 → as-given.
    let harnessVersion = input.harness.version || "latest";
    let harnessSpec: HarnessSpec | undefined;
    if (this.deps.harnesses) {
      try {
        const spec = await this.deps.harnesses.get(input.tenant, input.harness.id, harnessVersion);
        harnessVersion = spec.version;
        harnessSpec = spec;
      } catch {
        // 미등록/빌트인 → as-given, spec 임베드 없음
      }
    }

    const ts = this.now();
    const record: ScorecardRecord = {
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // 해석된 구체 버전(never "latest")
      status: "queued",
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.track(
      record.id,
      input.tenant,
      dataset,
      input.harness.id,
      harnessVersion,
      harnessSpec,
      input.judges ?? [],
      input.runtime,
    );
    return record;
  }

  get(id: string): Promise<ScorecardRecord | undefined> {
    return this.deps.store.get(id);
  }

  list(tenant?: string): Promise<ScorecardRecord[]> {
    return this.deps.store.list(tenant);
  }

  // 트레이스 인제스트 — 외부에서 이미 수행한 트레이스로 scorecard 생성(하니스 미실행). dataset 해석(없으면 404) → queued → 비동기 채점.
  async ingest(input: IngestScorecardInput): Promise<ScorecardRecord> {
    const dataset = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");
    const harnessVersion = input.harness.version || "latest";
    const ts = this.now();
    const record: ScorecardRecord = {
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // 트레이스를 만든 하니스(라벨)
      status: "queued",
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.trackIngest(
      record.id,
      input.tenant,
      dataset,
      input.harness.id,
      harnessVersion,
      input.traces,
      input.judges ?? [],
    );
    return record;
  }

  // baseline vs candidate 비교 — 같은 케이스 위 메트릭 delta + pass 전이(회귀/개선). 둘 다 이 워크스페이스 소유 + 완료여야.
  async diff(tenant: string, baselineId: string, candidateId: string): Promise<ScorecardDiff> {
    const baseline = await this.requireSucceeded(tenant, baselineId);
    const candidate = await this.requireSucceeded(tenant, candidateId);
    return diffScorecards(baseline, candidate);
  }

  // 워크스페이스 스코프 + 완료(scorecard 존재) 보장. 없으면 404(존재 누출 금지), 미완료면 400.
  private async requireSucceeded(tenant: string, id: string): Promise<Scorecard> {
    const record = await this.deps.store.get(id);
    if (!record || record.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' 를 찾을 수 없습니다.`);
    if (!record.scorecard)
      throw new BadRequestError(
        "BAD_REQUEST",
        { id, status: record.status },
        `scorecard '${id}' 가 아직 완료되지 않았습니다(status=${record.status}).`,
      );
    return record.scorecard;
  }

  private async track(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessId: string,
    harnessVersion: string,
    harnessSpec: HarnessSpec | undefined,
    judges: Array<{ id: string; version: string }>,
    runtime: string | undefined,
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    // 각 케이스 디스패치에 tenant/spec 을 주입하고 케이스별로 budget admit/settle(단일 run 과 동일 회계).
    const dispatch: Dispatch = async (job) => {
      this.deps.budget?.admit(tenant); // 초과 시 throw → 배치 실패
      const enriched: AgentJob = { ...job, tenant, ...(harnessSpec ? { harnessSpec } : {}) };
      const result = await this.deps.dispatcher.dispatch(enriched);
      this.deps.budget?.settle(tenant, costOf(result));
      return result;
    };
    try {
      // runtime 선택 시 각 케이스 placement.target 으로 주입 → RuntimeDispatcher 가 테넌트 런타임으로 라우팅.
      const cases = runtime
        ? dataset.cases.map((c) => ({ ...c, placement: { ...c.placement, target: runtime } }))
        : dataset.cases;
      const suite: Suite = { id: dataset.id, harness: { id: harnessId }, cases };
      const scorecard = await runSuite(suite, harnessVersion, dispatch, { concurrency: this.concurrency });
      await this.applyJudges(tenant, dataset, scorecard.results, judges); // 트레이스 → judge 점수(컨트롤플레인)
      const summary = summarizeScorecard(scorecard);
      await this.deps.store.update(id, { status: "succeeded", scorecard, summary, updatedAt: this.now() });
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
    }
  }

  // 업로드된 트레이스 → CaseResult(트레이스 그레이더 재도출 + 업로드 점수) → judge 적용 → 집계. 하니스 디스패치 없음.
  private async trackIngest(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessId: string,
    harnessVersion: string,
    traces: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    try {
      const harnessLabel = `${harnessId}@${harnessVersion}`;
      const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
      const results: CaseResult[] = [];
      for (const up of traces) {
        const evalCase = caseById.get(up.caseId);
        if (!evalCase) continue; // 데이터셋에 없는 caseId 는 스킵(정렬 불가)
        const snapshot = up.snapshot ?? { kind: "repo", diff: "", changedFiles: [], headSha: "ingested" };
        const ctx: GradeContext = { case: evalCase, trace: up.trace, snapshot };
        // 트레이스 전용 그레이더 재도출(steps/cost/latency) — 라이브 run 과 같은 메트릭으로 diff 정렬.
        const derived = await Promise.all([stepsGrader, costGrader, latencyGrader].map((g) => g.grade(ctx)));
        results.push({
          caseId: up.caseId,
          harness: harnessLabel,
          trace: up.trace,
          snapshot,
          scores: [...derived, ...(up.scores ?? [])],
        });
      }
      const scorecard: Scorecard = { suiteId: dataset.id, harness: harnessLabel, results };
      await this.applyJudges(tenant, dataset, results, judges); // 트레이스 → judge 점수(컨트롤플레인)
      const summary = summarizeScorecard(scorecard);
      await this.deps.store.update(id, { status: "succeeded", scorecard, summary, updatedAt: this.now() });
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
    }
  }

  // 선택된 judge 들을 각 케이스 트레이스에 적용 → judge:<id> 점수를 결과 scores 에 덧붙인다(요약에 반영).
  // 없는 judge 는 스킵; judge/runner 미설정이면 no-op(judge 미선택 run 과 동일).
  private async applyJudges(
    tenant: string,
    dataset: Dataset,
    results: CaseResult[],
    judges: Array<{ id: string; version: string }>,
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
        const ctx: GradeContext = { case: evalCase, trace: result.trace, snapshot: result.snapshot };
        result.scores.push(await runner.run(spec, tenant, ctx));
      }
    }
  }
}
