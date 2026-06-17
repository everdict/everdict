// 가중 공정 큐(Weighted Fair Queueing). 멀티테넌트에서 한 테넌트의 대량 제출이
// 다른 테넌트를 굶기지 않게, 각 항목에 "가상 완료시간(virtual finish)"을 매겨 그 순서로 뽑는다.
//
// 모델(단순화·문서화):
//  - 테넌트별 weight(기본 1). 항목 cost=1.
//  - enqueue 시 vf = max(globalVClock, lastVf[tenant]) + cost/weight; lastVf[tenant]=vf.
//  - 낮은 vf 부터 처리(동률은 입력 순서 seq). dequeue 시 globalVClock = max(globalVClock, vf).
//    → 쉬던 테넌트는 globalVClock 기준으로만 출발(크레딧 적립 불가), 바쁜 테넌트는 vf 가 계속
//      커져서 다른 테넌트가 사이사이 끼어든다. weight 가 크면 vf 증가가 느려 더 자주 뽑힌다.
//
// 용량/쿼터로 "지금 못 보내는" 항목은 호출부가 건너뛰므로, 이 큐는 순서 제공 + 제거만 담당한다.
interface FairNode<T> {
  item: T;
  tenant: string;
  vf: number;
  seq: number;
}

export interface FairQueueOptions<T> {
  tenantOf: (item: T) => string;
  weightFor?: (tenant: string) => number; // 기본 1
}

export class FairQueue<T> {
  private readonly nodes: FairNode<T>[] = [];
  private readonly lastVf = new Map<string, number>();
  private vclock = 0;
  private seq = 0;

  constructor(private readonly opts: FairQueueOptions<T>) {}

  get size(): number {
    return this.nodes.length;
  }

  enqueue(item: T): void {
    const tenant = this.opts.tenantOf(item);
    const weight = Math.max(1e-9, this.opts.weightFor?.(tenant) ?? 1);
    const start = Math.max(this.vclock, this.lastVf.get(tenant) ?? 0);
    const vf = start + 1 / weight;
    this.lastVf.set(tenant, vf);
    this.nodes.push({ item, tenant, vf, seq: this.seq++ });
  }

  // 공정 순서(vf 오름차순; 동률은 입력 순서) 스냅샷. 호출부가 이 순서로 배치를 시도한다.
  ordered(): T[] {
    return [...this.nodes].sort((a, b) => a.vf - b.vf || a.seq - b.seq).map((n) => n.item);
  }

  // 항목을 제거하고 가상 시계를 그 vf 로 전진(공정성 기준점 갱신).
  remove(item: T): boolean {
    const idx = this.nodes.findIndex((n) => n.item === item);
    if (idx < 0) return false;
    const [node] = this.nodes.splice(idx, 1);
    if (node) this.vclock = Math.max(this.vclock, node.vf);
    return true;
  }

  // 현재 대기 중인 테넌트별 큐 길이(관측용).
  queuedByTenant(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.nodes) out[n.tenant] = (out[n.tenant] ?? 0) + 1;
    return out;
  }
}
