import type { Dispatcher } from "@assay/backends";
import { type BudgetTracker, costOf } from "@assay/backends";
import { type AgentJob, AppError, type EvalCase } from "@assay/core";
import type { RunRecord, RunStore } from "@assay/db";

export interface SubmitInput {
  tenant: string;
  harness: { id: string; version: string };
  case: EvalCase;
  webhookUrl?: string;
}

export interface RunServiceDeps {
  dispatcher: Dispatcher; // Scheduler(권장) 또는 Router — placement/공정성/오토스케일은 그쪽이 담당
  store: RunStore;
  budget?: BudgetTracker; // API 가 admission 게이트(초과 시 402)와 cost settle 을 담당
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
    const job: AgentJob = { evalCase: input.case, harness: input.harness, tenant: input.tenant };
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
