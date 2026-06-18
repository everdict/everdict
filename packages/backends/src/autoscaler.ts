// 큐 깊이 기반 오토스케일러: 스케줄러의 부하(대기 + 진행중)를 보고 용량을 늘리고 줄인다.
// 용량 인지 배치가 "자리 없으면 큐잉" 한다면, 오토스케일러는 그 backlog 를 보고 "자리를 늘린다".
// 실제 작동은 ScalingTarget 이 추상화 — in-memory 슬롯/Nomad Autoscaler/cloud ASG/K8s replica patch.

export interface LoadSignal {
  queued: number; // 대기 중인 잡 수
  inFlight: number; // 진행 중인 잡 수
}

export interface AutoscalePolicy {
  min: number; // 최소 용량 (0 = scale-to-zero 허용)
  max: number; // 최대 용량 (실 인프라 상한)
  // 부하→목표 용량(슬롯). 기본: demand = inFlight + queued (대기를 모두 흡수하도록).
  targetSlots?: (load: LoadSignal, current: number) => number;
  scaleDownAfterTicks?: number; // 다운스케일 히스테리시스(플래핑 방지). 기본 3
}

// 스케일 대상 — 실제 용량 조정 메커니즘을 추상화.
export interface ScalingTarget {
  readonly id: string;
  current(): number | Promise<number>;
  scaleTo(desired: number): void | Promise<void>;
}

// 목표 용량 계산 (순수/결정적). demand 를 [min,max] 로 클램프.
export function desiredCapacity(load: LoadSignal, current: number, policy: AutoscalePolicy): number {
  const demand = policy.targetSlots ? policy.targetSlots(load, current) : load.inFlight + load.queued;
  return Math.max(policy.min, Math.min(policy.max, Math.ceil(demand)));
}

// in-memory 슬롯 카운트 — 백엔드 maxConcurrent 에 fn 으로 주입해 닫힌 루프를 만든다.
export class MutableSlots implements ScalingTarget {
  constructor(
    readonly id: string,
    private slots: number,
  ) {}
  current(): number {
    return this.slots;
  }
  scaleTo(desired: number): void {
    this.slots = desired;
  }
  // 백엔드 maxConcurrent 로 넘길 게터.
  readonly get = (): number => this.slots;
}

export interface AutoscalerOptions {
  signal: () => LoadSignal; // 예: () => aggregateStats(scheduler)
  targets: ScalingTarget[];
  policy: AutoscalePolicy;
  intervalMs?: number; // start() 의 틱 주기 (기본 1000)
  onScale?: (targetId: string, from: number, to: number) => void;
  onChanged?: () => void; // 스케일 직후 호출 — 스케줄러 re-pump 훅 (sched.poke)
}

export class Autoscaler {
  private readonly downTicks = new Map<string, number>(); // 대상별 연속 다운 후보 틱
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: AutoscalerOptions) {}

  async tick(): Promise<void> {
    const load = this.opts.signal();
    const threshold = this.opts.policy.scaleDownAfterTicks ?? 3;
    let changed = false;
    for (const target of this.opts.targets) {
      const cur = await target.current();
      const desired = desiredCapacity(load, cur, this.opts.policy);
      if (desired > cur) {
        this.downTicks.set(target.id, 0);
        await target.scaleTo(desired); // 업스케일은 즉시 (backlog 해소 우선)
        this.opts.onScale?.(target.id, cur, desired);
        changed = true;
      } else if (desired < cur) {
        const d = (this.downTicks.get(target.id) ?? 0) + 1;
        this.downTicks.set(target.id, d);
        if (d >= threshold) {
          // 다운스케일은 유휴/과프로비전이 충분히 지속될 때만 (플래핑 방지)
          this.downTicks.set(target.id, 0);
          await target.scaleTo(desired);
          this.opts.onScale?.(target.id, cur, desired);
          changed = true;
        }
      } else {
        this.downTicks.set(target.id, 0);
      }
    }
    if (changed) this.opts.onChanged?.();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

// 스케줄러 stats() → LoadSignal (편의).
export function aggregateLoad(stats: { queued: number; inFlight: Record<string, number> }): LoadSignal {
  return { queued: stats.queued, inFlight: Object.values(stats.inFlight).reduce((a, b) => a + b, 0) };
}
