// Leader election for the control plane's singleton loops (docs/architecture/multi-replica.md).
//
// Most background loops are safe on every replica because their step is an atomic CLAIM on the store (a
// `FOR UPDATE SKIP LOCKED` dequeue, a first-report-wins transition, a `DELETE … WHERE older_than`): the store
// picks one winner and the losers no-op. The dangerous ones are the read-then-act loops — scale a shared
// deployment from a reading, reclaim work found in flight, notify someone about a stale row — where N replicas
// take N actions on one world. Those run under `whenLeader`.
//
// The gate is deliberately advisory: the timer stays registered on every replica (so failover needs no restart,
// the new leader's next tick just starts doing the work) and a loop that is not leader returns immediately.
export interface LeaderElector {
  // Does THIS process hold the lease right now? Synchronous by design — a loop's tick asks it, and an answer
  // that needs a round-trip would put the database in the path of every timer on every replica.
  isLeader(): boolean;
  // Contend for the lease and keep renewing it. Resolves after the FIRST attempt, so a boot-time pass placed
  // after `await start()` behaves as it did single-process: the leader runs it, the others skip it.
  start(): Promise<void>;
  // Stop renewing and give the lease back, so failover is immediate instead of waiting out the TTL.
  stop(): Promise<void>;
}

// The single-process shape: no Postgres, no peers, nothing to elect. Behavior identical to before leadership
// existed — every gated loop runs.
export const soleLeader: LeaderElector = {
  isLeader: () => true,
  async start() {},
  async stop() {},
};

// Wrap a periodic side effect so it only runs on the leader. Returns a callback shaped for setInterval; the
// wrapped function is never called on a follower, so it needs no leadership awareness of its own.
export function whenLeader(elector: LeaderElector, fn: () => void): () => void {
  return () => {
    if (elector.isLeader()) fn();
  };
}
