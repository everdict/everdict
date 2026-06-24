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
  type JudgeRunConfig,
  type JudgeSpec,
  type MetricSpec,
  NotFoundError,
  type Placement,
  ScoreSchema,
  type Scorecard,
  type Suite,
  TraceEventSchema,
} from "@assay/core";
import type { ScorecardRecord, ScorecardStore } from "@assay/db";
import { costGrader, latencyGrader, stepsGrader } from "@assay/graders";
import type { DatasetRegistry, HarnessInstanceRegistry, JudgeRegistry, MetricRegistry } from "@assay/registry";
import { type ArtifactStore, offloadSnapshot } from "@assay/storage";
import {
  type Dispatch,
  type ScorecardDiff,
  type ScorecardTrend,
  diffScorecards,
  evalMetric,
  runSuite,
  summarizeScorecard,
  trendSeries,
} from "@assay/suite";
import type { TraceSource, TraceSourceConfig } from "@assay/trace";
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
  metrics: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type IngestScorecardBody = z.infer<typeof IngestScorecardBodySchema>;
export type IngestScorecardInput = IngestScorecardBody & { tenant: string };

// pull 인제스트 본문 — 테넌트 OTel/MLflow 에서 runId 별 트레이스를 당겨와 채점(하니스 미실행).
// source 자격증명은 authSecret 이름(SecretStore)으로만 — spec 에 평문 토큰 금지.
export const PullIngestBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  source: z.object({
    kind: z.enum(["otel", "mlflow"]),
    endpoint: z.string().url(),
    authSecret: z.string().optional(), // SecretStore 키 이름 → 그 값을 Authorization 헤더로 그대로(스킴 포함: "Bearer …"|"Basic …")
  }),
  runs: z.array(z.object({ caseId: z.string(), runId: z.string() })).min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  metrics: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type PullIngestBody = z.infer<typeof PullIngestBodySchema>;
export type PullIngestInput = PullIngestBody & { tenant: string };

export interface RunScorecardInput {
  tenant: string;
  // 제출자(principal.subject) — 비공개 repo 케이스의 개인 소유 연결을 resolve 할 owner("내 연결로 clone").
  // 결과적으로 비공개-repo 데이터셋은 사실상 단일 소유(케이스의 connectionId 는 그 소유자가 제출할 때만 resolve).
  submittedBy?: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string };
  judges?: Array<{ id: string; version: string }>; // 선택한 Agent Judge 들 — 트레이스에 적용
  metrics?: Array<{ id: string; version: string }>; // 선택한 등록 Metric 들 — 결과 scores 위에 post-hoc 적용
  runtime?: string; // 실행할 테넌트 Runtime id(placement.target). 없으면 기본 백엔드.
  judge?: JudgeRunConfig; // inline judge grader 채점 모델 override(미지정이면 워크스페이스 기본)
}

export interface ScorecardServiceDeps {
  dispatcher: Dispatcher; // 케이스를 잡으로 디스패치(단일 run 과 동일 경로)
  store: ScorecardStore;
  datasets: DatasetRegistry; // 데이터셋 해석(소유/_shared 폴백) + 케이스 로드
  harnesses?: HarnessInstanceRegistry; // 인스턴스 해석(template+pins→resolved HarnessSpec). 빌트인은 폴백.
  judges?: JudgeRegistry; // judge 해석(소유/_shared 폴백)
  metrics?: MetricRegistry; // 등록 metric 해석(소유/_shared 폴백) — post-hoc 합격규칙 적용
  judgeRunner?: JudgeRunner; // 트레이스 기반 judge 실행(model 호출 / skip)
  // 워크스페이스 기본 judge 모델(inline judge grader 채점용). 요청별 override(RunScorecardInput.judge)가 우선.
  judgeFor?: (tenant: string) => JudgeRunConfig | undefined | Promise<JudgeRunConfig | undefined>;
  budget?: BudgetTracker; // 케이스마다 admission/settle
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource; // pull 인제스트용 trace source 팩토리(@assay/trace)
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // 테넌트 SecretStore 값(서버 내부 주입)
  // 비공개 repo 시드용 토큰 resolve — 케이스 env.source.connectionId → 외부 계정 연결 토큰. 단일 run 과 동일(RunService.repoTokenFor).
  // 연결은 개인 소유라 owner(=제출자 subject)로 resolve. 데이터셋의 케이스마다 적용 → 비공개-repo 데이터셋 배치 eval. 토큰은 잡(repoToken)에만 transient.
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // 완료 콜백(succeeded/failed) — 완료 알림(Mattermost 등). 실패는 스코어카드 결과 무관(서비스가 swallow).
  onComplete?: (tenant: string, record: ScorecardRecord) => Promise<void>;
  artifacts?: ArtifactStore; // 설정 시 os-use 스크린샷을 object storage 로 오프로드(레코드엔 URL 만)
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
    // judge 모델: 요청 override → 워크스페이스 기본(DB) → 없음(inline judge grader 는 agent 에서 skip).
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);

    await this.deps.store.create(record);
    void this.track(
      record.id,
      input.tenant,
      input.submittedBy ?? input.tenant, // owner — 비공개 repo 케이스를 제출자의 개인 연결로 clone
      dataset,
      input.harness.id,
      harnessVersion,
      harnessSpec,
      input.judges ?? [],
      input.runtime,
      judge,
      input.metrics ?? [],
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
      `${input.harness.id}@${harnessVersion}`,
      input.traces,
      input.judges ?? [],
      input.metrics ?? [],
    );
    return record;
  }

  // pull 인제스트 — 테넌트 OTel/MLflow 에서 runId 별 트레이스를 당겨와 scorecard 생성. dataset 해석(없으면 404) → queued → 비동기.
  async ingestPull(input: PullIngestInput): Promise<ScorecardRecord> {
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
    void this.trackPull(
      record.id,
      input.tenant,
      dataset,
      `${input.harness.id}@${harnessVersion}`,
      input.source,
      input.runs,
      input.judges ?? [],
      input.metrics ?? [],
    );
    return record;
  }

  // baseline vs candidate 비교 — 같은 케이스 위 메트릭 delta + pass 전이(회귀/개선). 둘 다 이 워크스페이스 소유 + 완료여야.
  async diff(tenant: string, baselineId: string, candidateId: string): Promise<ScorecardDiff> {
    const baseline = await this.requireSucceeded(tenant, baselineId);
    const candidate = await this.requireSucceeded(tenant, candidateId);
    return diffScorecards(baseline, candidate);
  }

  // 기간 트렌드 / 회귀-오버-타임 — 한 (dataset, metric) 의 스코어카드들을 시간순으로 늘어놓고 baseline 대비 회귀를 표시.
  // 목록(경량 summary)만으로 계산 — 무거운 트레이스 불필요. ScorecardRecord 가 TrendCard 를 구조적으로 만족.
  async trend(
    tenant: string,
    opts: { datasetId: string; metric: string; harnessId?: string; from?: string; to?: string; baseline?: string },
  ): Promise<ScorecardTrend> {
    const records = await this.deps.store.list(tenant);
    return trendSeries(records, opts);
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

  // 케이스 repo 시드가 비공개(git + connectionId)면 owner(제출자 subject)의 개인 연결 토큰을 resolve. public/비-repo/미설정이면 undefined.
  private async resolveRepoToken(owner: string, evalCase: AgentJob["evalCase"]): Promise<string | undefined> {
    if (!this.deps.repoTokenFor) return undefined;
    const env = evalCase.env;
    if (env.kind !== "repo") return undefined;
    const src = env.source;
    if (!("git" in src) || !src.connectionId) return undefined;
    return this.deps.repoTokenFor(owner, src.connectionId).catch(() => undefined);
  }

  private async track(
    id: string,
    tenant: string,
    owner: string, // 제출자 subject — 비공개 repo 케이스 토큰 resolve 용(개인 소유 연결)
    dataset: Dataset,
    harnessId: string,
    harnessVersion: string,
    harnessSpec: HarnessSpec | undefined,
    judges: Array<{ id: string; version: string }>,
    runtime: string | undefined,
    judge: JudgeRunConfig | undefined,
    metrics: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    // 각 케이스 디스패치에 tenant/spec/judge 모델을 주입하고 케이스별로 budget admit/settle(단일 run 과 동일 회계).
    const dispatch: Dispatch = async (job) => {
      this.deps.budget?.admit(tenant); // 초과 시 throw → 배치 실패
      // 케이스가 비공개 repo(git + connectionId)면 제출자의 개인 연결 토큰을 resolve 해 잡에 transient 로 싣는다(단일 run 과 동일).
      const repoToken = await this.resolveRepoToken(owner, job.evalCase);
      const enriched: AgentJob = {
        ...job,
        tenant,
        // owner(제출자 subject) — self-hosted 러너 디스패치 소유자 확인 + lease 큐 키(단일 run 과 동일).
        ...(owner ? { submittedBy: owner } : {}),
        ...(harnessSpec ? { harnessSpec } : {}),
        ...(judge ? { judge } : {}),
        ...(repoToken ? { repoToken } : {}),
      };
      const result = await this.deps.dispatcher.dispatch(enriched);
      // 셀프호스티드 실행은 유저 로그인이 결제 — 워크스페이스 usd/tokens 버짓 미차감(단일 run 과 동일).
      if (result.provenance?.ranOn !== "self-hosted") this.deps.budget?.settle(tenant, costOf(result));
      return result;
    };
    try {
      // runtime 선택 시 각 케이스 placement.target 으로 주입 → RuntimeDispatcher 가 테넌트 런타임으로 라우팅.
      const cases = runtime
        ? dataset.cases.map((c) => ({ ...c, placement: { ...c.placement, target: runtime } }))
        : dataset.cases;
      const suite: Suite = { id: dataset.id, harness: { id: harnessId }, cases };
      const scorecard = await runSuite(suite, harnessVersion, dispatch, { concurrency: this.concurrency });
      // runtime = 산출 run 의 배치 → judge 를 같은 런타임에 co-locate(관측물 옆에서 판정). ingest 경로엔 산출 run 없음.
      await this.applyJudges(tenant, dataset, scorecard.results, judges, runtime); // 트레이스 → judge 점수(컨트롤플레인)
      await this.applyMetrics(tenant, scorecard.results, metrics); // 등록 metric → 합격규칙 점수(judge 뒤: judge 점수에도 임계 가능)
      await this.offloadResults(id, scorecard.results); // os-use 스크린샷 → object storage(레코드 슬림)
      const summary = summarizeScorecard(scorecard);
      await this.deps.store.update(id, { status: "succeeded", scorecard, summary, updatedAt: this.now() });
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
    }
    // 완료 알림(Mattermost 등) — 최신 레코드로. 실패는 스코어카드 결과 무관(swallow).
    if (this.deps.onComplete) {
      const rec = await this.deps.store.get(id);
      if (rec) await this.deps.onComplete(tenant, rec).catch(() => {});
    }
  }

  // push 인제스트: 업로드된 트레이스를 그대로 finishIngest 로.
  private async trackIngest(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    traces: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
    metrics: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    try {
      await this.finishIngest(id, tenant, dataset, harnessLabel, traces, judges, metrics);
    } catch (err) {
      await this.failIngest(id, err);
    }
  }

  // pull 인제스트: 테넌트 trace source(OTel/MLflow)에서 runId 별로 트레이스를 당겨와 finishIngest 로.
  private async trackPull(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    source: PullIngestBody["source"],
    runs: PullIngestBody["runs"],
    judges: Array<{ id: string; version: string }>,
    metrics: Array<{ id: string; version: string }>,
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    try {
      if (!this.deps.buildTraceSource)
        throw new BadRequestError("BAD_REQUEST", {}, "trace source 빌더가 설정되지 않았습니다(pull 비활성).");
      // 자격증명: source.authSecret 이름 → 테넌트 SecretStore 값을 Authorization 헤더로 그대로 주입.
      // 값에 스킴을 포함한다(예: "Bearer <token>" [OTel/Jaeger] 또는 "Basic <base64>" [MLflow]) — 스킴 하드코딩 금지.
      let headers: Record<string, string> | undefined;
      if (source.authSecret) {
        const secrets = await (this.deps.secretsFor?.(tenant) ?? Promise.resolve<Record<string, string>>({}));
        const token = secrets[source.authSecret];
        if (token) headers = { authorization: token };
      }
      const src = this.deps.buildTraceSource({
        kind: source.kind,
        endpoint: source.endpoint,
        ...(headers ? { headers } : {}),
      });
      const perCase: IngestScorecardBody["traces"] = [];
      for (const r of runs) {
        const trace = await src.fetch(r.runId); // 외부 실패는 UpstreamError → catch → failed
        perCase.push({ caseId: r.caseId, trace });
      }
      await this.finishIngest(id, tenant, dataset, harnessLabel, perCase, judges, metrics);
    } catch (err) {
      await this.failIngest(id, err);
    }
  }

  // 공유: perCase 트레이스 → CaseResult(트레이스 그레이더 재도출 + 업로드 점수) → judge → 집계 저장(succeeded). 실패는 throw.
  private async finishIngest(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessLabel: string,
    perCase: IngestScorecardBody["traces"],
    judges: Array<{ id: string; version: string }>,
    metrics: Array<{ id: string; version: string }>,
  ): Promise<void> {
    const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
    const results: CaseResult[] = [];
    for (const up of perCase) {
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
    await this.applyMetrics(tenant, results, metrics); // 등록 metric → 합격규칙 점수(judge 뒤)
    await this.offloadResults(id, results); // os-use 스크린샷 → object storage(레코드 슬림)
    const summary = summarizeScorecard(scorecard);
    await this.deps.store.update(id, { status: "succeeded", scorecard, summary, updatedAt: this.now() });
  }

  private async failIngest(id: string, err: unknown): Promise<void> {
    const error =
      err instanceof AppError
        ? { code: err.code, message: err.message }
        : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
    await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
  }

  // os-use 스크린샷(동봉 base64)을 object storage 로 오프로드 → 각 결과 snapshot.screenshotRef=URL, screenshot 비움(레코드
  // 슬림). best-effort: 실패하면 base64 유지(스코어카드 자체엔 영향 없음). applyJudges 후에 호출(registry judge 가 이미지 사용 후).
  private async offloadResults(id: string, results: CaseResult[]): Promise<void> {
    if (!this.deps.artifacts) return;
    for (const r of results) {
      try {
        r.snapshot = await offloadSnapshot(r.snapshot, this.deps.artifacts, `scorecards/${id}/${r.caseId}.png`);
      } catch {}
    }
  }

  // 선택된 judge 들을 각 케이스 트레이스에 적용 → judge:<id> 점수를 결과 scores 에 덧붙인다(요약에 반영).
  // 없는 judge 는 스킵; judge/runner 미설정이면 no-op(judge 미선택 run 과 동일).
  private async applyJudges(
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
        // 산출 run 의 placement 재구성(track 의 케이스 주입과 동일): runtime 선택 시 target 으로 덮어쓴다.
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
  private async applyMetrics(
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
}
