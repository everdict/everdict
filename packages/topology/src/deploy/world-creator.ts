import type { WorldCreator } from "@everdict/application-control";
import type { ServiceHarnessSpec, TopologyService } from "@everdict/contracts";
import { type TopologyRuntime, worldTopologyId } from "./topology-runtime.js";

// ── MAKING AND UNMAKING A WORLD, OVER THE TOPOLOGY RUNTIME (world-and-engagement-model.md, 3.9) ──────
//
// The runtime already knows how to stand a set of services up, tear them down and describe what is standing.
// What it does not have is the PROTOCOL around that — record before you create, and settle only on a
// read-back — which lives in `@everdict/application-control` and calls this.
//
// The world is addressed as a synthetic service topology keyed by the RUN — the run of the LEDGER ROW, which
// for a `per-run` world is the case that created it and for a `per-case` world is the only case there is. So
// two worlds never collide, a leaked one names the run that made it, and `describeTopology` answers about
// that world and nothing else.
//
// It is deliberately NOT a warm-pool entry: the ledger owns when a world may be reclaimed (the refcount says
// who is inside it), and the pool's idle sweeper defers to `isWorldTopology` rather than answering the same
// question from `lastUsedAt` — which a shared world, ensured once and used for hours, would fail.
export function topologyWorldCreator(runtime: TopologyRuntime): WorldCreator {
  const specFor = (runId: string, services: unknown[]): ServiceHarnessSpec =>
    ({
      kind: "service",
      id: worldTopologyId(runId),
      version: "1",
      services: services as TopologyService[],
      dependencies: [],
      // A world is ACTED ON, not driven: it has no front door of its own and Everdict never submits to it.
      // The services' ports are the whole interface, which is what the environment's wiring names.
      frontDoor: { service: (services as TopologyService[])[0]?.name ?? "world", submit: "POST /" },
      traceSource: { kind: "otel", endpoint: "http://unused.invalid" },
    }) as ServiceHarnessSpec;

  return {
    async create({ runId, services }) {
      const handle = await runtime.ensureTopology(specFor(runId, services));
      return { endpoints: handle.endpoints };
    },
    async destroy({ runId, services }) {
      if (runtime.teardown === undefined)
        // A runtime that cannot tear a world down must not be handed one to create: the alternative is a
        // world with no ending, which is the leak this whole lane exists to prevent.
        throw new Error(`the ${runtime.id} runtime cannot tear a topology down — it must not create worlds`);
      await runtime.teardown(specFor(runId, services));
    },
    async standing({ runId, services }) {
      // The verified zero, in the runtime's own words. `describeTopology` is best-effort BY CONTRACT — it
      // answers `undefined` when it cannot tell — and that is exactly the third value the release needs:
      // "we could not find out" is never a licence to settle.
      if (runtime.describeTopology === undefined) return undefined;
      const status = await runtime.describeTopology(specFor(runId, services));
      return status === undefined ? undefined : status.deployed;
    },
  };
}
