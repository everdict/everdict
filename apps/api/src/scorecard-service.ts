import { type BudgetTracker, type Dispatcher, costOf } from "@assay/backends";
import { type AgentJob, AppError, type Dataset, type HarnessSpec, type Suite } from "@assay/core";
import type { ScorecardRecord, ScorecardStore } from "@assay/db";
import type { DatasetRegistry, HarnessRegistry } from "@assay/registry";
import { type Dispatch, runSuite, summarizeScorecard } from "@assay/suite";

export interface RunScorecardInput {
  tenant: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string };
}

export interface ScorecardServiceDeps {
  dispatcher: Dispatcher; // 케이스를 잡으로 디스패치(단일 run 과 동일 경로)
  store: ScorecardStore;
  datasets: DatasetRegistry; // 데이터셋 해석(소유/_shared 폴백) + 케이스 로드
  harnesses?: HarnessRegistry; // 하니스 버전 해석(latest→구체) + spec 임베드(선언형). 빌트인은 폴백.
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
    void this.track(record.id, input.tenant, dataset, input.harness.id, harnessVersion, harnessSpec);
    return record;
  }

  get(id: string): Promise<ScorecardRecord | undefined> {
    return this.deps.store.get(id);
  }

  list(tenant?: string): Promise<ScorecardRecord[]> {
    return this.deps.store.list(tenant);
  }

  private async track(
    id: string,
    tenant: string,
    dataset: Dataset,
    harnessId: string,
    harnessVersion: string,
    harnessSpec: HarnessSpec | undefined,
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
      const suite: Suite = { id: dataset.id, harness: { id: harnessId }, cases: dataset.cases };
      const scorecard = await runSuite(suite, harnessVersion, dispatch, { concurrency: this.concurrency });
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
}
