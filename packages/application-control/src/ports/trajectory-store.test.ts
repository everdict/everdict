import type { TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { INFRA_EMITTER, type TrajectoryStore, executionSegment, sealExecutionPlanes } from "./trajectory-store.js";

type Seal = Parameters<TrajectoryStore["seal"]>[0];

function recorder() {
  const seals: Seal[] = [];
  const store: Pick<TrajectoryStore, "seal"> = {
    async seal(input) {
      seals.push(input);
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: input.events.length,
        sealedAt: "2026-08-03T00:00:00.000Z",
        created: true,
      };
    },
  };
  return { seals, store };
}

const agentEvents: TraceEvent[] = [
  { t: 1, kind: "tool_call", id: "c1", name: "skill_view", args: {} },
  { t: 2, kind: "message", role: "assistant", text: "done" },
];
const infraEvents: TraceEvent[] = [
  { t: 0, kind: "infra", scope: "placement", message: "scheduled", at: "2026-08-03T00:00:02.000Z" },
  { t: 5, kind: "infra", scope: "placement", message: "started", at: "2026-08-03T00:00:01.000Z" },
];

describe("sealExecutionPlanes — the agent's plane and the orchestrator's are different emitters", () => {
  it("splits an interleaved stream into two segments", async () => {
    const { store, seals } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [infraEvents[0] as TraceEvent, ...agentEvents, infraEvents[1] as TraceEvent],
    });
    expect(seals).toHaveLength(2);
    expect(seals[0]?.emitter).toBeUndefined(); // the execution's own plane keeps the default emitter
    expect(seals[1]?.emitter).toBe(INFRA_EMITTER);
  });

  it("keeps placement noise OUT of what a judge reads", async () => {
    const { store, seals } = recorder();
    await sealExecutionPlanes(store, { runId: "r1", tenant: "acme", events: [...agentEvents, ...infraEvents] });
    expect(seals[0]?.events.every((e) => e.kind !== "infra")).toBe(true);
    expect(seals[1]?.events.every((e) => e.kind === "infra")).toBe(true);
  });

  it("anchors the infra plane on the EARLIEST absolute stamp its emitter reported, not on event order", async () => {
    const { store, seals } = recorder();
    await sealExecutionPlanes(store, { runId: "r1", tenant: "acme", events: [...agentEvents, ...infraEvents] });
    expect(seals[1]?.t0).toBe("2026-08-03T00:00:01.000Z");
  });

  it("leaves the infra plane unanchored when no emitter reported an absolute stamp", async () => {
    const { store, seals } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [...agentEvents, { t: 0, kind: "infra", scope: "placement", message: "no clock" }],
    });
    expect(seals[1]?.t0).toBeUndefined();
  });

  it("seals one segment when a run has only one plane", async () => {
    const onlyAgent = recorder();
    await sealExecutionPlanes(onlyAgent.store, { runId: "r1", tenant: "acme", events: agentEvents });
    expect(onlyAgent.seals).toHaveLength(1);
    const onlyInfra = recorder();
    await sealExecutionPlanes(onlyInfra.store, { runId: "r1", tenant: "acme", events: infraEvents });
    expect(onlyInfra.seals).toHaveLength(1);
    expect(onlyInfra.seals[0]?.emitter).toBe(INFRA_EMITTER);
  });

  it("writes the execution's plane FIRST so `events` resolves to it even if the second write loses", async () => {
    const { store, seals } = recorder();
    await sealExecutionPlanes(store, { runId: "r1", tenant: "acme", events: [...infraEvents, ...agentEvents] });
    expect(seals[0]?.events[0]?.kind).not.toBe("infra");
  });

  it("does not make the infra plane the judged evidence — it is not an execution emitter", () => {
    const segments = [
      { emitter: INFRA_EMITTER, source: "run" as const, eventCount: 2, sealedAt: "", events: infraEvents },
      { emitter: "run", source: "run" as const, eventCount: 2, sealedAt: "", events: agentEvents },
    ];
    expect(executionSegment(segments)?.emitter).toBe("run");
  });
});
