import { type AgentJob, type CaseResult, NotFoundError, RateLimitError } from "@assay/core";
import { FairQueue } from "./fair-queue.js";
import type { BackendRegistry } from "./registry.js";

const DEFAULT_TENANT = "default";
const tenantOf = (job: AgentJob): string => job.tenant ?? DEFAULT_TENANT;

// 한 백엔드의 가용 슬롯 스냅샷.
export interface BackendSlot {
  name: string;
  free: number;
  total: number;
}

// 여유 있는 후보 중 하나를 고르는 배치 정책(순수/결정적이어야 함).
export interface PlacementPolicy {
  choose(candidates: BackendSlot[], job: AgentJob): string | undefined;
}

// 가장 여유 많은 곳(분산). 동률은 이름순으로 결정적.
export const leastLoadedPolicy: PlacementPolicy = {
  choose(candidates) {
    return [...candidates].sort((a, b) => b.free - a.free || a.name.localeCompare(b.name))[0]?.name;
  },
};

// 여유가 가장 적지만 1 이상인 곳(집적/bin-pack). 유휴 풀 scale-to-zero 에 유리.
export const binPackPolicy: PlacementPolicy = {
  choose(candidates) {
    return [...candidates].sort((a, b) => a.free - b.free || a.name.localeCompare(b.name))[0]?.name;
  },
};

interface QueueEntry {
  job: AgentJob;
  resolve: (r: CaseResult) => void;
  reject: (e: unknown) => void;
}

export interface SchedulerOptions {
  policy?: PlacementPolicy;
  maxQueueDepth?: number; // 백프레셔: 큐가 이만큼 차면 RateLimitError(429)
  // 하니스↔백엔드 매칭 등 후보를 제한하는 커스텀 훅(미지정 시 pin 또는 전체 백엔드).
  eligible?: (job: AgentJob, names: string[]) => string[];
  // 멀티테넌트 공정성: WFQ 가중치(클수록 더 자주) + 테넌트별 동시 실행 상한(쿼터).
  weightFor?: (tenant: string) => number; // 기본 1
  tenantQuota?: (tenant: string) => number; // 기본 무제한
}

// 용량 인지 + 테넌트 공정 스케줄러: 백엔드 여유를 보고 자리 있는 곳에 배치하되,
// 대기 잡은 WFQ(가중 공정 큐) 순서로 뽑고 테넌트별 쿼터를 넘지 않게 한다. 자리/쿼터가 없으면
// 큐잉했다가 슬롯이 비면 자동 펌프한다(HOL 회피). Dispatcher 호환(드롭인).
export class Scheduler {
  private readonly policy: PlacementPolicy;
  private readonly inFlight = new Map<string, number>(); // backend name → 진행중
  private readonly tenantInFlight = new Map<string, number>(); // tenant → 진행중
  private readonly queue: FairQueue<QueueEntry>;
  private pumping = false;

  constructor(
    private readonly registry: BackendRegistry,
    private readonly opts: SchedulerOptions = {},
  ) {
    this.policy = opts.policy ?? leastLoadedPolicy;
    this.queue = new FairQueue<QueueEntry>({
      tenantOf: (e) => tenantOf(e.job),
      weightFor: opts.weightFor,
    });
  }

  dispatch(job: AgentJob): Promise<CaseResult> {
    const max = this.opts.maxQueueDepth ?? Number.POSITIVE_INFINITY;
    if (this.queue.size >= max) {
      return Promise.reject(
        new RateLimitError("RATE_LIMITED", { queueDepth: this.queue.size }, "스케줄러 큐가 가득 찼습니다."),
      );
    }
    return new Promise<CaseResult>((resolve, reject) => {
      this.queue.enqueue({ job, resolve, reject });
      void this.pump();
    });
  }

  // 관측용 스냅샷(테스트/모니터링).
  stats(): {
    queued: number;
    inFlight: Record<string, number>;
    tenantInFlight: Record<string, number>;
    queuedByTenant: Record<string, number>;
  } {
    return {
      queued: this.queue.size,
      inFlight: Object.fromEntries(this.inFlight),
      tenantInFlight: Object.fromEntries(this.tenantInFlight),
      queuedByTenant: this.queue.queuedByTenant(),
    };
  }

  private eligibleNames(job: AgentJob): string[] {
    const pin = job.evalCase.placement?.target;
    if (pin) {
      if (!this.registry.has(pin)) {
        throw new NotFoundError("NOT_FOUND", { backend: pin }, `백엔드 '${pin}' 가 등록되어 있지 않습니다.`);
      }
      return [pin];
    }
    const all = this.registry.names();
    return this.opts.eligible ? this.opts.eligible(job, all) : all;
  }

  private async freeSlots(): Promise<Map<string, BackendSlot>> {
    const slots = new Map<string, BackendSlot>();
    await Promise.all(
      this.registry.names().map(async (name) => {
        const cap = await this.registry.get(name).capacity();
        const used = Math.max(cap.used, this.inFlight.get(name) ?? 0);
        slots.set(name, { name, total: cap.total, free: Math.max(0, cap.total - used) });
      }),
    );
    return slots;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return; // 재진입 방지 — 한 펌프가 끝나면 settle 이 다시 부른다
    this.pumping = true;
    try {
      let placedAny = true;
      while (placedAny && this.queue.size > 0) {
        placedAny = false;
        const slots = await this.freeSlots();
        // WFQ 공정 순서로 훑되, 쿼터/용량으로 지금 못 보내는 잡은 건너뛴다(HOL 회피).
        for (const entry of this.queue.ordered()) {
          const tenant = tenantOf(entry.job);
          const quota = this.opts.tenantQuota?.(tenant) ?? Number.POSITIVE_INFINITY;
          if ((this.tenantInFlight.get(tenant) ?? 0) >= quota) continue; // 테넌트 쿼터 도달

          let names: string[];
          try {
            names = this.eligibleNames(entry.job);
          } catch (err) {
            // pin 미등록 등 → 해당 잡만 즉시 실패시키고 계속.
            this.queue.remove(entry);
            entry.reject(err);
            placedAny = true;
            continue;
          }

          const candidates = names
            .map((n) => slots.get(n))
            .filter((s): s is BackendSlot => s !== undefined && s.free > 0);
          if (candidates.length === 0) continue; // 지금 자리 없음 → 다음 잡 시도

          const chosen = this.policy.choose(candidates, entry.job);
          if (chosen === undefined) continue;

          this.queue.remove(entry);
          const slot = slots.get(chosen);
          if (slot) slot.free -= 1; // 같은 펌프 패스 내 로컬 차감
          this.inFlight.set(chosen, (this.inFlight.get(chosen) ?? 0) + 1);
          this.tenantInFlight.set(tenant, (this.tenantInFlight.get(tenant) ?? 0) + 1);
          this.runOne(entry, chosen, tenant);
          placedAny = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private runOne(entry: QueueEntry, name: string, tenant: string): void {
    this.registry
      .get(name)
      .dispatch(entry.job)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.inFlight.set(name, Math.max(0, (this.inFlight.get(name) ?? 1) - 1));
        this.tenantInFlight.set(tenant, Math.max(0, (this.tenantInFlight.get(tenant) ?? 1) - 1));
        void this.pump();
      });
  }
}
