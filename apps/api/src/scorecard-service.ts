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
  NotFoundError,
  ScoreSchema,
  type Scorecard,
  type Suite,
  TraceEventSchema,
} from "@assay/core";
import type { RunStore, ScorecardOrigin, ScorecardRecord, ScorecardStep, ScorecardStore } from "@assay/db";
import { costGrader, latencyGrader, stepsGrader } from "@assay/graders";
import type { DatasetRegistry, HarnessInstanceRegistry, JudgeRegistry } from "@assay/registry";
import { type ArtifactStore, offloadSnapshot } from "@assay/storage";
import {
  type Dispatch,
  type Leaderboard,
  type ScorecardDiff,
  type ScorecardTrend,
  caseVerdict,
  diffScorecards,
  leaderboard,
  runSuite,
  scorecardModels,
  summarizeScorecard,
  trendSeries,
} from "@assay/suite";
import type { TraceSource, TraceSourceConfig } from "@assay/trace";
import { z } from "zod";
import { executeCase } from "./execute-case.js";
import type { JudgeRunner } from "./judge-runner.js";
import { ScoringService } from "./scoring-service.js";

// 케이스 실패/판정 사유 한 줄 — 진행 스텝 메시지용. trace 의 error 이벤트 > pass:false 인 score.detail 순. 길면 자른다.
function caseReason(r: CaseResult): string | undefined {
  const errEvent = r.trace.find((e) => e.kind === "error");
  const raw =
    errEvent && "message" in errEvent
      ? errEvent.message
      : r.scores.find((s) => s.pass === false && typeof s.detail === "string")?.detail;
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
}

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
export type IngestScorecardInput = IngestScorecardBody & {
  tenant: string;
  submittedBy?: string; // 제출자 subject → 레코드 createdBy(실행자 표기/필터)
  origin?: ScorecardOrigin;
};

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
});
export type PullIngestBody = z.infer<typeof PullIngestBodySchema>;
export type PullIngestInput = PullIngestBody & {
  tenant: string;
  submittedBy?: string; // 제출자 subject → 레코드 createdBy(실행자 표기/필터)
  origin?: ScorecardOrigin;
};

// principal.via → origin.source 매핑 — 제출 경로 provenance(어디서 발사됐나).
// oidc=사람(web UI 토큰), github-actions=CI OIDC 페더레이션, 그 외(api-key/runner)=api. 스케줄 발사는 "schedule" 을 직접 스탬프.
export function originSource(via: string): string {
  if (via === "oidc") return "web";
  if (via === "github-actions") return "github-actions";
  return "api";
}

export interface RunScorecardInput {
  tenant: string;
  // 제출자(principal.subject) — 비공개 repo 케이스의 개인 소유 연결을 resolve 할 owner("내 연결로 clone").
  // 결과적으로 비공개-repo 데이터셋은 사실상 단일 소유(케이스의 connectionId 는 그 소유자가 제출할 때만 resolve).
  submittedBy?: string;
  dataset: { id: string; version: string };
  // pins = 제출 시점 임시 핀 오버라이드(슬롯→이미지, 레지스트리 무변경) — CI PR 발사가 한 서비스 이미지만 스왑해 평가.
  // 기록은 origin.pinOverrides 로(재현 근거). durable 한 변경은 POST /harnesses/:id/pins(새 인스턴스 버전)로.
  harness: { id: string; version: string; pins?: Record<string, string> };
  origin?: ScorecardOrigin; // 트리거 출처(provenance) — 라우트/스케줄이 source 를 스탬프
  judges?: Array<{ id: string; version: string }>; // 선택한 Agent Judge 들 — 트레이스에 적용
  runtime?: string; // 실행할 테넌트 Runtime id(placement.target). 없으면 기본 백엔드.
  judge?: JudgeRunConfig; // inline judge grader 채점 모델 override(미지정이면 워크스페이스 기본)
  // 한 배치 안에서 동시에 디스패치할 케이스 수(runSuite 병렬도). 미지정이면 서비스 기본.
  // 셀프호스티드 런타임은 이만큼 잡이 lease 큐에 파킹되고, 러너가 그만큼 동시에 lease 해야 실제 case-level 병렬이 된다.
  concurrency?: number;
}

export interface ScorecardServiceDeps {
  dispatcher: Dispatcher; // 케이스를 잡으로 디스패치(단일 run 과 동일 경로)
  store: ScorecardStore;
  datasets: DatasetRegistry; // 데이터셋 해석(소유/_shared 폴백) + 케이스 로드
  harnesses?: HarnessInstanceRegistry; // 인스턴스 해석(template+pins→resolved HarnessSpec). 빌트인은 폴백.
  judges?: JudgeRegistry; // judge 해석(소유/_shared 폴백)
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
  // 설정 시 케이스마다 자식 run(RunRecord)을 팬아웃 생성해 각 케이스가 addressable run(트레이스/usage/provenance)이 되게 한다.
  // 미설정이면 현행대로 자식 run 없이 임베드 scorecard 만(단일 run 과 같은 RunStore 를 공유). 자식은 활동 리스트에서 기본 숨김.
  runStore?: RunStore;
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
  // 채점 관심사는 별도 서비스로 분리 — 라이브 배치와 ingest 가 동일 채점 로직을 공유(실행과 독립).
  private readonly scoring: ScoringService;
  // in-flight 배치의 협조적 취소 핸들(supersede 용) — 단일 control-plane 프로세스 전제(in-process 랑데부와 동일).
  // abort 는 "남은 케이스 미발사"까지만: 이미 발사된 백엔드 잡의 강제 kill 은 별개 문제(후속).
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: ScorecardServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.concurrency = deps.concurrency ?? 4;
    this.scoring = new ScoringService({
      ...(deps.judges ? { judges: deps.judges } : {}),
      ...(deps.judgeRunner ? { judgeRunner: deps.judgeRunner } : {}),
    });
  }

  // 데이터셋을 동기 해석(NotFound→404), 하니스 버전/spec 해석 후 레코드 생성, 비동기 배치 실행.
  async submit(input: RunScorecardInput): Promise<ScorecardRecord> {
    const dataset = await this.deps.datasets.get(input.tenant, input.dataset.id, input.dataset.version || "latest");

    // 하니스 버전 해석(latest→구체) + 선언형 spec 임베드. 빌트인(scripted/claude-code)은 레지스트리에 없음 → as-given.
    // 제출 시점 임시 핀(pins)이 있으면 폴백 없이 resolveWithPins — 핀을 조용히 무시한 채 평가가 통과하면 안 된다.
    const pins = input.harness.pins && Object.keys(input.harness.pins).length > 0 ? input.harness.pins : undefined;
    let harnessVersion = input.harness.version || "latest";
    let harnessSpec: HarnessSpec | undefined;
    if (pins) {
      if (!this.deps.harnesses)
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: input.harness.id },
          "핀 오버라이드(pins)는 레지스트리에 등록된 하니스에서만 가능합니다.",
        );
      const spec = await this.deps.harnesses.resolveWithPins(input.tenant, input.harness.id, harnessVersion, pins);
      harnessVersion = spec.version; // 기반 인스턴스의 구체 버전(임시 핀은 버전을 만들지 않는다)
      harnessSpec = spec;
    } else if (this.deps.harnesses) {
      try {
        const spec = await this.deps.harnesses.get(input.tenant, input.harness.id, harnessVersion);
        harnessVersion = spec.version;
        harnessSpec = spec;
      } catch {
        // 미등록/빌트인 → as-given, spec 임베드 없음
      }
    }

    // provenance: 호출부가 준 origin 에 임시 핀 기록을 얹는다. 핀만 있고 origin 이 없어도 기록은 남긴다(재현 근거).
    const origin: ScorecardOrigin | undefined =
      input.origin || pins
        ? { source: input.origin?.source ?? "api", ...(input.origin ?? {}), ...(pins ? { pinOverrides: pins } : {}) }
        : undefined;

    const ts = this.now();
    const record: ScorecardRecord = {
      id: this.newId(),
      tenant: input.tenant,
      dataset: { id: dataset.id, version: dataset.version },
      harness: { id: input.harness.id, version: harnessVersion }, // 해석된 구체 버전(never "latest")
      status: "queued",
      ...(origin ? { origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}), // 실행자 — origin(어디서)과 짝인 '누가'
      createdAt: ts,
      updatedAt: ts,
    };
    // judge 모델: 요청 override → 워크스페이스 기본(DB) → 없음(inline judge grader 는 agent 에서 skip).
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);

    await this.deps.store.create(record);
    // 서버측 supersede — 같은 PR(origin.repo+prNumber) × 같은 (harness, dataset) 의 in-flight 배치를 회수하고
    // 이번 발사로 대체한다. GH쪽 concurrency 는 "워크플로"만 취소하고 이미 제출된 배치는 서버에서 계속 돌기
    // 때문(고아 평가의 환경/예산/러너 큐 점유 방지). merge/dev 발사(prNumber 없음)는 대상 아님.
    if (origin?.repo && origin.prNumber !== undefined) {
      await this.supersedeInFlight(input.tenant, origin.repo, origin.prNumber, input.harness.id, dataset.id, record.id);
    }
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
      // 요청 병렬도가 우선, 없으면 서비스 기본. 양수 정수만(경계는 라우트/MCP 가 Zod 로 강제).
      input.concurrency ?? this.concurrency,
    );
    return record;
  }

  // 같은 (repo, PR, harness, dataset) 키의 queued/running 배치를 superseded 로 종결하고 abort 시그널을 보낸다.
  // status/error 를 먼저 마킹(track 종결이 aborted 가드로 존중) + 남은 케이스 발사 중단. 이미 발사된 케이스는
  // 자연 완료돼 자식 run 에 기록된다(강제 kill 아님). superseded 는 succeeded 가 아니므로 baseline/리더보드 무오염.
  private async supersedeInFlight(
    tenant: string,
    repo: string,
    prNumber: number,
    harnessId: string,
    datasetId: string,
    newId: string,
  ): Promise<void> {
    const candidates: ScorecardRecord[] = [];
    for (const status of ["queued", "running"] as const) {
      candidates.push(...(await this.deps.store.list(tenant, { status, dataset: datasetId, harness: harnessId })));
    }
    for (const r of candidates) {
      if (r.id === newId) continue;
      if (r.origin?.repo?.toLowerCase() !== repo.toLowerCase() || r.origin?.prNumber !== prNumber) continue;
      await this.deps.store.update(r.id, {
        status: "superseded",
        error: { code: "SUPERSEDED", message: `같은 PR 의 더 새 발사(${newId})로 대체됨` },
        updatedAt: this.now(),
      });
      this.inFlight.get(r.id)?.abort(); // 남은 케이스 미발사(협조적) — track 이 부분 결과를 붙여 종결
    }
  }

  // dispatched 스코어카드는 무거운 scorecard(케이스 결과)를 embed 하지 않고 runIds 만 저장(저장 dedup) →
  // get 에서 자식 run 의 최종 결과로 scorecard 를 hydrate 한다(응답 형태·웹·diff 는 embed 시절과 동일).
  // embed 가 이미 있으면(no-runStore / ingest / 구 레코드) 그대로 반환. runStore 미설정이면 hydrate 불가 → 그대로.
  async get(id: string): Promise<ScorecardRecord | undefined> {
    const record = await this.deps.store.get(id);
    if (!record || record.scorecard || !record.runIds?.length || !this.deps.runStore) return record;
    const children = await this.deps.runStore.list(record.tenant, { scorecardId: id });
    const results = children.map((c) => c.result).filter((r): r is CaseResult => r !== undefined);
    if (results.length === 0) return record;
    const harness = `${record.harness.id}@${record.harness.version}`;
    return { ...record, scorecard: { suiteId: record.dataset.id, harness, results } };
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
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
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
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
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
    // SQL 레벨에서 dataset(+선택 harness)·succeeded 로 좁힌다 — 전 워크스페이스 스캔 회피(suite 가 방어적으로 재필터).
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
    });
    return trendSeries(records, opts);
  }

  // 벤치마크(dataset)별 리더보드 — 한 데이터셋의 스코어카드들을 (harness × model) 로 그룹핑해 metric 기준 랭킹.
  // 목록(경량 summary+models)만으로 계산 — 무거운 트레이스 불필요. ScorecardRecord 가 LeaderboardCard 를 구조적으로 만족.
  async leaderboard(
    tenant: string,
    opts: {
      datasetId: string;
      metric: string;
      harnessId?: string;
      model?: string;
      judgeModel?: string;
      window?: "latest" | "best";
    },
  ): Promise<Leaderboard> {
    // SQL 레벨에서 dataset(+선택 harness)·succeeded 로 좁힌다 — model/judgeModel/window 등 요약-파생 축은 suite 가 필터.
    const records = await this.deps.store.list(tenant, {
      dataset: opts.datasetId,
      status: "succeeded",
      ...(opts.harnessId ? { harness: opts.harnessId } : {}),
    });
    return leaderboard(records, opts);
  }

  // model 축 백필 — models 가 아직 없는(구) succeeded 스코어카드의 저장 트레이스에서 관측 모델을 도출해 채운다.
  // 멱등: 이미 models 가 있으면 스킵. 트레이스가 진실이라 관측만(선언 폴백 없음). 대량이므로 get 은 필요한 것만.
  async backfillModels(tenant: string): Promise<{ scanned: number; updated: number }> {
    const records = await this.deps.store.list(tenant); // list 는 models 를 포함(경량) → 이미 있는지 판별 가능
    let updated = 0;
    for (const r of records) {
      if (r.models || r.status !== "succeeded") continue; // 이미 채워졌거나 산출물 없음
      const full = await this.deps.store.get(r.id); // 트레이스는 무거운 scorecard 안에만
      if (!full?.scorecard) continue;
      await this.deps.store.update(r.id, { models: scorecardModels(full.scorecard), updatedAt: this.now() });
      updated += 1;
    }
    return { scanned: records.length, updated };
  }

  // 워크스페이스 스코프 + 완료(scorecard 존재) 보장. 없으면 404(존재 누출 금지), 미완료면 400.
  private async requireSucceeded(tenant: string, id: string): Promise<Scorecard> {
    const record = await this.get(id); // get 이 dedup 저장을 자식 run 으로 hydrate — diff 는 embed/reference 무관하게 동작
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

  // 배치 judge/offload 로 최종화된 케이스 결과를 각 자식 run 에 반영한다(embed 를 저장하지 않으므로 get 이
  // hydrate 할 원천이 최신이어야 한다). caseId → childId 매핑으로 결과를 해당 run 에 update.
  private async writeBackResults(caseToChild: Map<string, string>, results: CaseResult[]): Promise<void> {
    const store = this.deps.runStore;
    if (!store) return;
    for (const r of results) {
      const childId = caseToChild.get(r.caseId);
      if (childId) await store.update(childId, { result: r, updatedAt: this.now() });
    }
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
    concurrency: number, // 동시 디스패치할 케이스 수(요청 override→서비스 기본은 submit 에서 resolve).
  ): Promise<void> {
    // supersede 가 이 배치를 이미 회수했으면 시작하지 않는다(queued→superseded 를 running 으로 되살리는 역행 방지).
    if ((await this.deps.store.get(id))?.status === "superseded") return;
    // 협조적 취소 핸들 등록 — supersedeInFlight 가 abort 하면 runSuite 가 남은 케이스를 발사하지 않는다.
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    // 진행 과정(스텝) 타임라인 — run 이 진행되며 append + 증분 저장해 웹에서 "어디까지/무엇을" 하는지 보인다.
    const steps: ScorecardStep[] = [];
    const pushStep = (p: string, status: ScorecardStep["status"], message: string, caseId?: string): void => {
      steps.push({ ts: this.now(), phase: p, status, message, ...(caseId ? { caseId } : {}) });
    };
    const flushSteps = (): Promise<unknown> => this.deps.store.update(id, { steps: [...steps], updatedAt: this.now() });
    // 이 배치가 팬아웃한 자식 run: caseId → childId(runStore 설정 시). 완료 후 최종 결과 write-back + runIds 참조 저장에 쓴다.
    const caseToChild = new Map<string, string>();
    // 각 케이스 디스패치(오케 per-case): admit(배치라 per-case) → 잡 enrich → 순수 executeCase → settle.
    // 순수 실행(토큰 resolve+attach → dispatch)은 단일 run 과 공유하는 executeCase 가, 정산/자식-run 수명은 오케인 여기가 담당.
    // runStore 설정 시 케이스마다 자식 run(RunRecord)을 만들어 각 케이스가 addressable run(트레이스/usage/provenance)이 되게 한다.
    const dispatch: Dispatch = async (job) => {
      this.deps.budget?.admit(tenant); // 초과 시 throw → 배치 실패
      const enriched: AgentJob = {
        ...job,
        tenant,
        // owner(제출자 subject) — self-hosted 러너 디스패치 소유자 확인 + lease 큐 키(단일 run 과 동일).
        ...(owner ? { submittedBy: owner } : {}),
        ...(harnessSpec ? { harnessSpec } : {}),
        ...(judge ? { judge } : {}),
      };
      const runStore = this.deps.runStore;
      // 자식 run(있으면): running 으로 생성. parentScorecardId 태그로 활동 리스트에선 기본 숨김.
      let childId: string | undefined;
      if (runStore) {
        childId = this.newId();
        const ts = this.now();
        await runStore.create({
          id: childId,
          tenant,
          harness: { id: harnessId, version: harnessVersion },
          caseId: job.evalCase.id,
          status: "running",
          parentScorecardId: id,
          trigger: "scorecard",
          createdAt: ts,
          updatedAt: ts,
        });
        caseToChild.set(job.evalCase.id, childId);
      }
      try {
        const result = await executeCase(this.deps, owner, enriched);
        // 셀프호스티드 실행은 유저 자기 로그인이 결제 주체 — 워크스페이스 버짓 미차감(그 외는 비용만큼 settle). 단일 run 과 동일.
        if (result.provenance?.ranOn !== "self-hosted") this.deps.budget?.settle(tenant, costOf(result));
        if (runStore && childId) await runStore.update(childId, { status: "succeeded", result, updatedAt: this.now() });
        return result;
      } catch (err) {
        if (runStore && childId) {
          const error =
            err instanceof AppError
              ? { code: err.code, message: err.message }
              : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
          await runStore.update(childId, { status: "failed", error, updatedAt: this.now() });
        }
        throw err; // runSuite 가 케이스 격리(실패 CaseResult 로 박제)하도록 다시 던진다
      }
    };
    // 실패 시 "어떤 구간에서" 진단 — 파이프라인 구간을 따라가며 catch 가 그 구간을 error.phase 로 기록한다.
    let phase = "dispatch";
    let scorecard: Scorecard | undefined;
    try {
      // runtime 선택 시 각 케이스 placement.target 으로 주입 → RuntimeDispatcher 가 테넌트 런타임으로 라우팅.
      const cases = runtime
        ? dataset.cases.map((c) => ({ ...c, placement: { ...c.placement, target: runtime } }))
        : dataset.cases;
      const suite: Suite = { id: dataset.id, harness: { id: harnessId }, cases };
      pushStep("dispatch", "started", `${cases.length}개 케이스 실행 시작`);
      await flushSteps();
      // onResult: 케이스가 끝날 때마다(완료 순서) PASS/FAIL + 사유를 스텝으로 — "진행 과정"의 핵심.
      scorecard = await runSuite(suite, harnessVersion, dispatch, {
        concurrency,
        signal: controller.signal, // supersede 시 남은 케이스 미발사(이미 발사된 케이스는 자연 완료)
        onResult: (r) => {
          const v = caseVerdict(r);
          const reason = caseReason(r);
          const verdict = v == null ? "결과없음" : v ? "PASS" : "FAIL";
          pushStep(
            "case",
            v === false ? "failed" : "ok",
            `${r.caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`,
            r.caseId,
          );
          void flushSteps();
        },
      });
      pushStep("dispatch", "ok", `디스패치 완료 — ${scorecard.results.length}개 케이스`);
      await flushSteps();
      // supersede 됨 — 더 새 발사가 이 배치를 회수. 남은 파이프라인(judge/offload/알림)을 생략하고
      // 부분 결과만 붙여 superseded 로 종결한다(succeeded 가 아니므로 baseline/리더보드 무오염).
      if (controller.signal.aborted) {
        pushStep("supersede", "info", "같은 PR 의 더 새 발사로 대체됨 — 남은 케이스 미발사, 부분 결과만 보존");
        const hasChildren = caseToChild.size > 0;
        if (hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
        await this.deps.store.update(id, {
          status: "superseded",
          ...(scorecard.results.length > 0 ? { summary: summarizeScorecard(scorecard) } : {}),
          steps: [...steps],
          ...(hasChildren ? { runIds: [...caseToChild.values()] } : { scorecard }),
          updatedAt: this.now(),
        });
        this.inFlight.delete(id);
        return; // 대체된 배치의 완료 알림은 소음 — 생략
      }
      // runtime = 산출 run 의 배치 → judge 를 같은 런타임에 co-locate(관측물 옆에서 판정). ingest 경로엔 산출 run 없음.
      phase = "judges";
      if (judges.length > 0) {
        pushStep("judges", "started", `judge ${judges.length}종 적용`);
        await flushSteps();
      }
      await this.scoring.applyJudges(tenant, dataset, scorecard.results, judges, runtime); // 트레이스 → judge 점수(컨트롤플레인)
      if (judges.length > 0) {
        pushStep("judges", "ok", "judge 적용 완료");
        await flushSteps();
      }
      phase = "offload";
      await this.offloadResults(id, scorecard.results); // os-use 스크린샷 → object storage(레코드 슬림)
      phase = "persist";
      const summary = summarizeScorecard(scorecard);
      // 리더보드 model 축: 트레이스 관측 우선 + spec 선언(command 하니스만) 폴백.
      const declared = harnessSpec?.kind === "command" ? harnessSpec.model : undefined;
      const models = scorecardModels(scorecard, declared);
      // 리더보드 judge 축: 이 run 을 채점한 judge 모델(들) — inline config + 등록 model-judge spec.
      const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, judge);
      pushStep("persist", "ok", "집계·저장 완료");
      // 자식 run 이 있으면: judge/offload 로 최종화된 결과를 자식에 write-back 후 무거운 embed 대신 runIds 만 저장
      //  → get 이 자식에서 hydrate(저장 dedup, 응답 형태 불변). 자식이 없으면(no runStore) 현행대로 embed 저장.
      const hasChildren = caseToChild.size > 0;
      if (hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
      await this.deps.store.update(id, {
        // 파이프라인 도중(judge/offload) supersede 가 도착했으면 succeeded 로 되살리지 않는다 — 결과는 전부 붙지만
        // 더 새 발사가 이 PR 의 정답이므로 superseded 로 종결(리더보드/baseline 은 새 것만 본다).
        status: controller.signal.aborted ? "superseded" : "succeeded",
        summary,
        models,
        ...(judgeModels.length > 0 ? { judgeModels } : {}),
        steps: [...steps],
        ...(hasChildren ? { runIds: [...caseToChild.values()] } : { scorecard }),
        updatedAt: this.now(),
      });
    } catch (err) {
      const base =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      pushStep(phase, "failed", base.message);
      // 부분 결과 보존 — dispatch 이후(judge/offload) 실패면 이미 모인 케이스 결과를 같이 저장해 가시성을 남긴다.
      // 자식 run 이 있으면 success 경로와 동일하게 embed 대신 runIds 참조(부분) + 자식에 결과 write-back.
      const hasChildren = caseToChild.size > 0;
      if (scorecard && hasChildren) await this.writeBackResults(caseToChild, scorecard.results);
      const declared = harnessSpec?.kind === "command" ? harnessSpec.model : undefined;
      await this.deps.store.update(id, {
        // supersede 이후의 실패는 실패로 보고하지 않는다(회수된 배치의 잔여 에러는 소음) — superseded 유지.
        status: controller.signal.aborted ? "superseded" : "failed",
        error: { ...base, phase },
        steps: [...steps],
        ...(hasChildren ? { runIds: [...caseToChild.values()] } : {}),
        ...(scorecard
          ? {
              summary: summarizeScorecard(scorecard),
              models: scorecardModels(scorecard, declared),
              ...(hasChildren ? {} : { scorecard }), // 자식 있으면 embed 생략(get 이 hydrate)
            }
          : {}),
        updatedAt: this.now(),
      });
    }
    this.inFlight.delete(id);
    // 완료 알림(Mattermost 등) — 최신 레코드로. 실패는 스코어카드 결과 무관(swallow). 대체된 배치는 알림 생략.
    if (this.deps.onComplete && !controller.signal.aborted) {
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
  ): Promise<void> {
    await this.deps.store.update(id, { status: "running", updatedAt: this.now() });
    try {
      await this.finishIngest(id, tenant, dataset, harnessLabel, traces, judges);
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
      await this.finishIngest(id, tenant, dataset, harnessLabel, perCase, judges);
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
    await this.scoring.applyJudges(tenant, dataset, results, judges); // 트레이스 → judge 점수(컨트롤플레인)
    await this.offloadResults(id, results); // os-use 스크린샷 → object storage(레코드 슬림)
    const summary = summarizeScorecard(scorecard);
    // 인제스트는 하니스 spec 을 해석하지 않음 → 관측(트레이스)만으로 model 축.
    const models = scorecardModels(scorecard);
    // judge 축: 인제스트엔 inline judge 가 없으므로 적용된 등록 judge 들의 model 만.
    const judgeModels = await this.scoring.collectJudgeModels(tenant, judges, undefined);
    await this.deps.store.update(id, {
      status: "succeeded",
      scorecard,
      summary,
      models,
      ...(judgeModels.length > 0 ? { judgeModels } : {}),
      updatedAt: this.now(),
    });
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
}
