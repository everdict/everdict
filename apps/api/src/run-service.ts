import { type BudgetTracker, type Dispatcher, billingTenant, costOf } from "@everdict/backends";
import {
  type AgentJob,
  AppError,
  type EvalCase,
  type HarnessSecretMaps,
  type HarnessSpec,
  type JudgeRunConfig,
  type RegistryAuth,
  resolveHarnessSecrets,
} from "@everdict/core";
import type { RunRecord, RunStore } from "@everdict/db";
import { type ArtifactStore, offloadSnapshot } from "@everdict/storage";
import type { TraceSource, TraceSourceConfig } from "@everdict/trace";
import { executeCase } from "./execute-case.js";
import { assertRuntimeTarget } from "./require-runtime.js";

export interface SubmitInput {
  tenant: string;
  // 제출자(principal.subject) — 비공개 repo 시드의 개인 소유 연결을 resolve 할 owner("내 연결로 clone").
  // HTTP/MCP 라우트는 항상 principal.subject 를 싣는다; 미지정이면 resolveRepoToken 이 tenant 로 폴백(테스트 호환).
  submittedBy?: string;
  harness: { id: string; version: string };
  case: EvalCase;
  runtime?: string; // 실행할 테넌트 Runtime id(placement.target). 없으면 기본 백엔드(scorecard 와 동일 대칭).
  // 이 run 의 출처(활동 뷰 source 축): web|mcp|api|… 미지정이면 미설정(직접 API). scorecard 자식은 서비스가 "scorecard" 로 표시.
  trigger?: string;
  webhookUrl?: string;
  meterUsage?: boolean; // 이 요청만의 계측 override(미지정이면 워크스페이스 정책)
  judge?: JudgeRunConfig; // 이 요청만의 judge 모델 override(미지정이면 워크스페이스 기본)
}

export interface RunServiceDeps {
  dispatcher: Dispatcher; // Scheduler(권장) 또는 Router — placement/공정성/오토스케일은 그쪽이 담당
  store: RunStore;
  // 잡 밖 트레이스 수집(collect="control-plane")용 소스 팩토리 — executeCase 가 traceRef 결과를 완성할 때 사용.
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource;
  // 수집 pull 의 인증(traceRef.authSecret 이름 재해석) — 워크스페이스 SecretStore 복호화 값. scorecard 와 동일.
  secretsFor?: (tenant: string) => Promise<Record<string, string>>;
  // 정책 게이트: true 면 runtime/self 타깃 없는 run 을 제출 시 400(local 폴백 금지). API(main.ts)는 항상 true.
  // 미지정(테스트: mock dispatcher 직접 주입)=게이트 없음. env 토글 아님 — 배포의 고정 정책.
  requireRuntime?: boolean;
  budget?: BudgetTracker; // API 가 admission 게이트(초과 시 402)와 cost settle 을 담당
  // 선언형 하니스 spec 을 레지스트리에서 풀어 잡에 임베드(없으면 빌트인 id 분기). 없는 하니스는 reject → undefined 폴백.
  resolveHarness?: (tenant: string, id: string, version: string) => Promise<HarnessSpec | undefined>;
  // harness env 의 {secretRef} 해석용 — 공유(워크스페이스) + 제출자 개인 시크릿 두 티어. scope 로 골라 주입. scorecard 와 동일.
  scopedSecretsFor?: (tenant: string, subject?: string) => Promise<HarnessSecretMaps>;
  // 워크스페이스 단위 계측 정책(기본 off). 요청별 override(SubmitInput.meterUsage)가 이보다 우선.
  // async 허용 — DB 기반 워크스페이스 설정 스토어를 그대로 끼울 수 있다.
  meterUsageFor?: (tenant: string) => boolean | Promise<boolean>;
  // 워크스페이스 기본 judge 모델(inline judge grader 채점용). 요청별 override(SubmitInput.judge)가 우선.
  judgeFor?: (tenant: string) => JudgeRunConfig | undefined | Promise<JudgeRunConfig | undefined>;
  // 비공개 repo 시드용 토큰 resolve — evalCase.env.source.connectionId → 외부 계정 연결(Connected accounts) 토큰.
  // 연결은 개인 소유라 owner(=제출자 subject)로 resolve("내 연결로 clone"). 미설정/미해석이면 public clone.
  // 토큰은 잡(AgentJob.repoToken)에만 transient 로 실리고 레코드/케이스엔 저장 안 됨.
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // 워크스페이스 소유 GitHub App 토큰(우선) — 케이스 git URL owner 가 워크스페이스 installation 과 매칭되면 그 App 으로 발급.
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // 워크스페이스 이미지 레지스트리 pull 자격증명 — 잡 이미지가 그 레지스트리 것이면 job.registryAuth 로 attach(executeCase).
  registryAuthsFor?: (workspace: string) => Promise<RegistryAuth[]>;
  // 완료 콜백(succeeded/failed) — 완료 알림(Mattermost 등). 실패는 run 결과 무관(서비스가 swallow). webhook 과 별개.
  onComplete?: (tenant: string, record: RunRecord) => Promise<void>;
  // 아티팩트 스토어(설정 시): os-use 스크린샷을 object storage 로 오프로드 → 레코드엔 URL 만(base64 인라인 안 함).
  artifacts?: ArtifactStore;
  newId?: () => string;
  now?: () => string;
  fetch?: typeof fetch; // 웹훅용 (테스트 주입)
}

// run 의 비동기 수명을 관리: 접수(202) → 디스패처에 위임 → 완료 시 스토어 갱신 + 웹훅.
// HTTP 와 무관하게 단위 테스트 가능. AppError 는 그대로 던져 호출부(서버)가 상태코드로 매핑한다.
export class RunService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: RunServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.fetchImpl = deps.fetch ?? fetch;
  }

  // 동기 admission(예산 초과면 throw → 402). 통과하면 레코드 생성 후 비동기 디스패치(기다리지 않음).
  async submit(input: SubmitInput): Promise<RunRecord> {
    // 배포 정책: 실행 위치(등록 런타임 또는 self:<러너>)를 반드시 명시 — 없으면 400(조용한 local 폴백 차단).
    assertRuntimeTarget(this.deps.requireRuntime, input.runtime ?? input.case.placement?.target);
    this.deps.budget?.admit(input.tenant); // 초과 시 PaymentRequiredError(402) — run 생성 안 함
    // runtime 선택 시 케이스 placement.target 으로 주입 → RuntimeDispatcher 가 테넌트 런타임으로 라우팅(scorecard 와 동일 대칭).
    const effective: SubmitInput = input.runtime
      ? { ...input, case: { ...input.case, placement: { ...input.case.placement, target: input.runtime } } }
      : input;
    // 배치된 런타임(작업 큐 축) — 명시 runtime 또는 케이스 자체의 placement.target. 없으면 기본 백엔드(미설정).
    const placedRuntime = input.runtime ?? input.case.placement?.target;
    const ts = this.now();
    const record: RunRecord = {
      id: this.newId(),
      tenant: effective.tenant,
      harness: effective.harness,
      caseId: effective.case.id,
      status: "queued",
      ...(effective.trigger ? { trigger: effective.trigger } : {}), // 활동 뷰 source 축(web|mcp|api…)
      // 실행자 스탬프 — 알림 피드 수신자(notifications N2). 스코어카드 createdBy(0035)와 동일 패턴.
      ...(effective.submittedBy ? { createdBy: effective.submittedBy } : {}),
      ...(placedRuntime ? { runtime: placedRuntime } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.track(record.id, effective); // fire-and-track
    return record;
  }

  get(id: string): Promise<RunRecord | undefined> {
    return this.deps.store.get(id);
  }

  // 기본은 standalone run(활동 리스트) — scorecardId 지정 시 그 배치의 자식 run 만(스코어카드 상세 케이스 드릴다운).
  list(tenant?: string, opts?: { scorecardId?: string }): Promise<RunRecord[]> {
    return this.deps.store.list(tenant, opts);
  }

  private async track(id: string, input: SubmitInput): Promise<void> {
    // 선언형 하니스(command 등)는 레지스트리에서 spec 을 풀어 잡에 임베드 — 에이전트가 코드 없이 해석.
    // 빌트인(claude-code/scripted)은 레지스트리에 없으므로 undefined → id 분기로 폴백.
    const harnessSpec = this.deps.resolveHarness
      ? await this.deps.resolveHarness(input.tenant, input.harness.id, input.harness.version).catch(() => undefined)
      : undefined;
    // 계측: 요청 override → 워크스페이스 정책(DB) → off. 컨트롤플레인이 권위 — 잡에 실어 에이전트로 보낸다.
    const meterUsage =
      input.meterUsage ?? (this.deps.meterUsageFor ? await this.deps.meterUsageFor(input.tenant) : false);
    // judge 모델: 요청 override → 워크스페이스 기본(DB) → 없음(judge grader 는 skip). 키는 백엔드가 secretEnv 로 주입.
    const judge = input.judge ?? (this.deps.judgeFor ? await this.deps.judgeFor(input.tenant) : undefined);
    const job: AgentJob = {
      evalCase: input.case,
      harness: input.harness,
      tenant: input.tenant,
      meterUsage,
      ...(input.submittedBy ? { submittedBy: input.submittedBy } : {}),
      ...(harnessSpec ? { harnessSpec } : {}),
      ...(judge ? { judge } : {}),
    };
    try {
      // env 시크릿 참조({secretRef}) 해석(디스패치 직전) — 공유 + 제출자 개인 시크릿. 없으면 throw → run 실패로 격리.
      const secrets =
        job.harnessSpec && this.deps.scopedSecretsFor
          ? await this.deps.scopedSecretsFor(input.tenant, input.submittedBy)
          : undefined;
      const jobToRun =
        secrets && job.harnessSpec ? { ...job, harnessSpec: resolveHarnessSecrets(job.harnessSpec, secrets) } : job;
      // 순수 실행은 scorecard 와 공유하는 executeCase(토큰 resolve+attach → dispatch)가 담당. "뒤"(settle/offload/알림)는
      // 여기(오케)의 몫이다. admit 은 submit 에서 이미 동기로 카운트했으므로 중복하지 않는다.
      const result = await executeCase(this.deps, input.submittedBy ?? input.tenant, jobToRun);
      // 비용 귀속: 관리형=잡 테넌트 · 워크스페이스-공유 러너=그 워크스페이스(팀 자원) · 개인 러너=own-pays(미차감).
      const bill = billingTenant(result, input.tenant);
      if (bill) this.deps.budget?.settle(bill, costOf(result));
      // os-use 스크린샷(동봉 base64)을 object storage 로 오프로드 → 레코드엔 URL 만(슬림). 실패해도 run 은 성공(폴백: base64 유지).
      if (this.deps.artifacts && result.snapshot) {
        try {
          result.snapshot = await offloadSnapshot(result.snapshot, this.deps.artifacts, `runs/${id}.png`);
        } catch {}
      }
      await this.deps.store.update(id, { status: "succeeded", result, updatedAt: this.now() });
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
    }
    // 완료 알림(Mattermost 등) — 최신 레코드로. 실패는 run 결과 무관(swallow). webhook 과 독립.
    if (this.deps.onComplete) {
      const rec = await this.deps.store.get(id);
      if (rec) await this.deps.onComplete(input.tenant, rec).catch(() => {});
    }
    if (input.webhookUrl) await this.fireWebhook(input.webhookUrl, id);
  }

  private async fireWebhook(url: string, id: string): Promise<void> {
    const record = await this.deps.store.get(id);
    try {
      await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
    } catch {
      // 웹훅 실패는 run 결과에 영향 없음(스토어가 진실원천; 폴링으로도 조회 가능).
    }
  }
}
