import type { Dispatcher } from "@assay/backends";
import { type BudgetTracker, costOf } from "@assay/backends";
import { type AgentJob, AppError, type EvalCase, type HarnessSpec, type JudgeRunConfig } from "@assay/core";
import type { RunRecord, RunStore } from "@assay/db";

export interface SubmitInput {
  tenant: string;
  harness: { id: string; version: string };
  case: EvalCase;
  webhookUrl?: string;
  meterUsage?: boolean; // 이 요청만의 계측 override(미지정이면 워크스페이스 정책)
  judge?: JudgeRunConfig; // 이 요청만의 judge 모델 override(미지정이면 워크스페이스 기본)
}

export interface RunServiceDeps {
  dispatcher: Dispatcher; // Scheduler(권장) 또는 Router — placement/공정성/오토스케일은 그쪽이 담당
  store: RunStore;
  budget?: BudgetTracker; // API 가 admission 게이트(초과 시 402)와 cost settle 을 담당
  // 선언형 하니스 spec 을 레지스트리에서 풀어 잡에 임베드(없으면 빌트인 id 분기). 없는 하니스는 reject → undefined 폴백.
  resolveHarness?: (tenant: string, id: string, version: string) => Promise<HarnessSpec | undefined>;
  // 워크스페이스 단위 계측 정책(기본 off). 요청별 override(SubmitInput.meterUsage)가 이보다 우선.
  // async 허용 — DB 기반 워크스페이스 설정 스토어를 그대로 끼울 수 있다.
  meterUsageFor?: (tenant: string) => boolean | Promise<boolean>;
  // 워크스페이스 기본 judge 모델(inline judge grader 채점용). 요청별 override(SubmitInput.judge)가 우선.
  judgeFor?: (tenant: string) => JudgeRunConfig | undefined | Promise<JudgeRunConfig | undefined>;
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
    this.deps.budget?.admit(input.tenant); // 초과 시 PaymentRequiredError(402) — run 생성 안 함
    const ts = this.now();
    const record: RunRecord = {
      id: this.newId(),
      tenant: input.tenant,
      harness: input.harness,
      caseId: input.case.id,
      status: "queued",
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    void this.track(record.id, input); // fire-and-track
    return record;
  }

  get(id: string): Promise<RunRecord | undefined> {
    return this.deps.store.get(id);
  }

  list(tenant?: string): Promise<RunRecord[]> {
    return this.deps.store.list(tenant);
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
      ...(harnessSpec ? { harnessSpec } : {}),
      ...(judge ? { judge } : {}),
    };
    try {
      const result = await this.deps.dispatcher.dispatch(job);
      this.deps.budget?.settle(input.tenant, costOf(result));
      await this.deps.store.update(id, { status: "succeeded", result, updatedAt: this.now() });
    } catch (err) {
      const error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      await this.deps.store.update(id, { status: "failed", error, updatedAt: this.now() });
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
