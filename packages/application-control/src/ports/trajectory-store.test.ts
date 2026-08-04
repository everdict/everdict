import { EVERDICT_ATTR, OTEL_RESOURCE, TRACE_PLANE, type TraceEvent } from "@everdict/contracts";
import { spansToEvents } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import {
  INFRA_EMITTER,
  type SealInput,
  type TrajectoryStore,
  executionSegment,
  sealBody,
  sealExecutionPlanes,
} from "./trajectory-store.js";

function recorder() {
  const seals: SealInput[] = [];
  const store: Pick<TrajectoryStore, "seal"> = {
    async seal(input) {
      seals.push(input);
      const body = sealBody(input);
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: body.spans?.length ?? body.events.length,
        sealedAt: "2026-08-03T00:00:00.000Z",
        created: true,
      };
    },
  };
  // Deterministic span ids so a tree can be asserted on.
  let n = 0;
  const newSpanId = () => (++n).toString(16).padStart(16, "0");
  return { seals, store, newSpanId };
}

const AGENT_AT = "2026-08-03T00:00:03.000Z";
const agentEvents: TraceEvent[] = [
  { t: 1, at: AGENT_AT, kind: "tool_call", id: "c1", name: "skill_view", args: {} },
  { t: 2, at: "2026-08-03T00:00:04.000Z", kind: "tool_result", id: "c1", ok: true, output: "ok" },
  { t: 3, at: "2026-08-03T00:00:05.000Z", kind: "message", role: "assistant", text: "done" },
];
const infraEvents: TraceEvent[] = [
  {
    t: 0,
    kind: "infra",
    scope: "placement",
    event: "scheduled",
    message: "scheduled",
    at: "2026-08-03T00:00:02.000Z",
    node: "worker-3",
  },
  { t: 5, kind: "infra", scope: "placement", event: "started", message: "started", at: "2026-08-03T00:00:01.000Z" },
];

describe("sealExecutionPlanes — the agent's plane and the orchestrator's are different emitters", () => {
  it("splits an interleaved stream into two segments", async () => {
    const { store, seals, newSpanId } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [infraEvents[0] as TraceEvent, ...agentEvents, infraEvents[1] as TraceEvent],
      newSpanId,
    });
    expect(seals).toHaveLength(2);
    expect(seals[0]?.emitter).toBeUndefined(); // the execution's own plane keeps the default emitter
    expect(seals[1]?.emitter).toBe(INFRA_EMITTER);
  });

  it("keeps placement noise OUT of what a judge reads", async () => {
    const { store, seals, newSpanId } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [...agentEvents, ...infraEvents],
      newSpanId,
    });
    const judged = spansToEvents(seals[0]?.spans ?? []);
    expect(judged.every((e) => e.kind !== "infra")).toBe(true);
    expect(spansToEvents(seals[1]?.spans ?? []).every((e) => e.kind === "infra")).toBe(true);
  });

  it("seals the placement plane as ONE span with the run's real length, not a scatter of instants", async () => {
    const { store, seals, newSpanId } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [...agentEvents, ...infraEvents],
      newSpanId,
    });
    const placement = seals[1]?.spans?.[0];
    expect(seals[1]?.spans).toHaveLength(1); // one interval, not two points
    expect(placement?.kind).toBe("client"); // we are the orchestrator's caller
    expect(placement?.attributes[EVERDICT_ATTR.plane]).toBe(TRACE_PLANE.placement);
    // The node is OTel's own resource attribute, not a private key of ours.
    expect(placement?.resource?.[OTEL_RESOURCE.k8sNodeName]).toBe("worker-3");
    // Both instants survive as span EVENTS — the layer that had nowhere to live before.
    expect(placement?.events?.map((e) => e.name)).toEqual(["scheduled", "started"]);
    expect(Date.parse(placement?.endedAt ?? "") - Date.parse(placement?.startedAt ?? "")).toBe(1_000);
  });

  it("hangs the agent's root under the placement span — the job really did run inside the placed unit", async () => {
    const { store, seals, newSpanId } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [...agentEvents, ...infraEvents],
      newSpanId,
    });
    const placement = seals[1]?.spans?.[0];
    const root = seals[0]?.spans?.[0];
    expect(root?.parentSpanId).toBe(placement?.spanId);
    // One run is one trace, and the two planes agree on its id without ever speaking to each other.
    expect(root?.traceId).toBe(placement?.traceId);
  });

  it("anchors the infra plane on the EARLIEST absolute stamp its emitter reported, not on event order", async () => {
    const { store, seals, newSpanId } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [...agentEvents, ...infraEvents],
      newSpanId,
    });
    expect(seals[1]?.t0).toBe("2026-08-03T00:00:01.000Z");
  });

  it("falls back to sealing EVENTS when a plane carries no absolute time — never a tree we invented", async () => {
    const { store, seals, newSpanId } = recorder();
    // The self-reported `trace:file` shape: step numbers, no `at` anywhere.
    const undated: TraceEvent[] = [
      { t: 1, kind: "tool_call", id: "c1", name: "search", args: {} },
      { t: 2, kind: "tool_result", id: "c1", ok: true, output: "ok" },
    ];
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [...undated, { t: 0, kind: "infra", scope: "placement", message: "no clock" }],
      newSpanId,
    });
    expect(seals[0]?.spans).toBeUndefined();
    expect(seals[0]?.events).toEqual(undated);
    expect(seals[1]?.spans).toBeUndefined();
    expect(seals[1]?.t0).toBeUndefined();
  });

  it("seals one segment when a run has only one plane", async () => {
    const onlyAgent = recorder();
    await sealExecutionPlanes(onlyAgent.store, {
      runId: "r1",
      tenant: "acme",
      events: agentEvents,
      newSpanId: onlyAgent.newSpanId,
    });
    expect(onlyAgent.seals).toHaveLength(1);
    const onlyInfra = recorder();
    await sealExecutionPlanes(onlyInfra.store, {
      runId: "r1",
      tenant: "acme",
      events: infraEvents,
      newSpanId: onlyInfra.newSpanId,
    });
    expect(onlyInfra.seals).toHaveLength(1);
    expect(onlyInfra.seals[0]?.emitter).toBe(INFRA_EMITTER);
  });

  it("writes the execution's plane FIRST so `events` resolves to it even if the second write loses", async () => {
    const { store, seals, newSpanId } = recorder();
    await sealExecutionPlanes(store, {
      runId: "r1",
      tenant: "acme",
      events: [...infraEvents, ...agentEvents],
      newSpanId,
    });
    expect(seals[0]?.emitter).toBeUndefined();
    expect(spansToEvents(seals[0]?.spans ?? [])[0]?.kind).not.toBe("infra");
  });

  it("does not make the infra plane the judged evidence — it is not an execution emitter", () => {
    const segments = [
      {
        emitter: INFRA_EMITTER,
        source: "run" as const,
        eventCount: 2,
        sealedAt: "",
        format: "events" as const,
        events: infraEvents,
      },
      {
        emitter: "run",
        source: "run" as const,
        eventCount: 2,
        sealedAt: "",
        format: "events" as const,
        events: agentEvents,
      },
    ];
    expect(executionSegment(segments)?.emitter).toBe("run");
  });
});

describe("sealBody — exactly one body", () => {
  const base = { runId: "r1", tenant: "acme", source: "run" as const };

  it("refuses a seal that offers both — two sources of truth, one waiting to drift", () => {
    expect(() => sealBody({ ...base, events: [], spans: [] })).toThrow();
  });

  it("refuses a seal that offers neither", () => {
    expect(() => sealBody(base)).toThrow();
  });
});
