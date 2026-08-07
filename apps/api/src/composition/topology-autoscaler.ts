import type { LeaderElector } from "@everdict/application-control";
import type { BackendRegistry, Scheduler } from "@everdict/backends";
import { ServiceTopologyBackend, TopologyPoolAutoscaler } from "@everdict/topology";

// The actuation half of elastic topology capacity (docs/architecture/live-observability.md): scale each
// declared-scalable session service from the pool's live saturation + that harness's queued backlog. Always
// on — acting requires an explicit harness declaration (acquire.capacity.scale) AND a runtime that can address
// one service's scale (K8s), so with neither declared this loop only ever observes an empty roster. The
// sensing half (capacity() following the live pool) widens admission by itself once the scaled-out service
// reports a bigger pool.
export function startTopologyPoolAutoscaler(deps: {
  backends: BackendRegistry;
  scheduler: Scheduler;
  // Only the leader may ACT here (docs/architecture/multi-replica.md): a tick reads a pool's saturation and
  // then rewrites a SHARED deployment's replica count, so N replicas would compute N scaling decisions from
  // the same reading and fight each other over one service.
  leader: LeaderElector;
}): TopologyPoolAutoscaler {
  const { backends, scheduler, leader } = deps;
  const autoscaler = new TopologyPoolAutoscaler({
    // The live roster at each tick — rt:<tenant>:<id>@<version> topology backends register at first dispatch.
    // A follower reports an EMPTY roster, which is how the gate is expressed here: the loop keeps ticking (so a
    // replica promoted mid-life starts scaling without a restart) but has nothing to act on.
    hosts: () =>
      !leader.isLeader()
        ? []
        : backends
            .names()
            .map((name) => backends.get(name))
            .filter((b): b is ServiceTopologyBackend => b instanceof ServiceTopologyBackend),
    // Backlog attributable to ONE pool: queued cases whose harness@version is the pool's warm identity (the
    // zone suffix rides after "|"; an image-pin variant suffixes the version with -pin-<hash>). Global backlog
    // would over-scale every pool for one harness's burst.
    queuedFor: (key) => {
      const base = key.split("|")[0] ?? key;
      return scheduler.queueEntries().filter((entry) => {
        const hv = `${entry.harness.id}@${entry.harness.version}`;
        return base === hv || base.startsWith(`${hv}-pin-`);
      }).length;
    },
    onScale: (key, from, to) => console.log(`▶ pool autoscale ${key}: ${from} → ${to} replicas`),
    onScaled: () => scheduler.poke(), // freshly scaled capacity should drain the queue immediately
  });
  autoscaler.start();
  return autoscaler;
}
