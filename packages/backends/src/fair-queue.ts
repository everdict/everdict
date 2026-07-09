// Weighted Fair Queueing. So that in a multi-tenant setup one tenant's bulk submission doesn't starve others,
// assign each item a "virtual finish time" and pull in that order.
//
// Model (simplified/documented):
//  - per-tenant weight (default 1). item cost=1.
//  - on enqueue, vf = max(globalVClock, lastVf[tenant]) + cost/weight; lastVf[tenant]=vf.
//  - process from the lowest vf (ties broken by input order seq). On dequeue, globalVClock = max(globalVClock, vf).
//    → an idle tenant starts only from globalVClock (can't accrue credit), while a busy tenant's vf keeps
//      growing so other tenants slip in between. A larger weight makes vf grow slower, so it's pulled more often.
//
// The caller skips items that "can't be sent now" due to capacity/quota, so this queue only provides ordering + removal.
interface FairNode<T> {
  item: T;
  tenant: string;
  vf: number;
  seq: number;
}

export interface FairQueueOptions<T> {
  tenantOf: (item: T) => string;
  weightFor?: (tenant: string) => number; // default 1
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
    const node: FairNode<T> = { item, tenant, vf, seq: this.seq++ };
    // Keep `nodes` sorted by (vf, seq) so ordered() never sorts (it's called once per scheduler placement round).
    // seq is monotonic, so a new node always sorts AFTER any existing node of equal vf → the insertion point is the
    // first node with a strictly greater vf (upper bound on vf). Binary search for it.
    let lo = 0;
    let hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midNode = this.nodes[mid];
      if (midNode !== undefined && midNode.vf <= vf) lo = mid + 1;
      else hi = mid;
    }
    this.nodes.splice(lo, 0, node);
  }

  // A snapshot in fair order (ascending vf; ties by input order) — `nodes` is maintained sorted, so no sort here.
  ordered(): T[] {
    return this.nodes.map((n) => n.item);
  }

  // Remove an item and advance the virtual clock to its vf (updating the fairness reference point).
  remove(item: T): boolean {
    const idx = this.nodes.findIndex((n) => n.item === item);
    if (idx < 0) return false;
    const [node] = this.nodes.splice(idx, 1);
    if (node) this.vclock = Math.max(this.vclock, node.vf);
    return true;
  }

  // Current queue length per waiting tenant (for observation).
  queuedByTenant(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.nodes) out[n.tenant] = (out[n.tenant] ?? 0) + 1;
    return out;
  }
}
