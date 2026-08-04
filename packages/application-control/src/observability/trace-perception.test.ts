import type { TraceEvent, TraceThreshold } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { EmitPlatformEventInput, PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { TrajectoryMeta, TrajectoryStore } from "../ports/trajectory-store.js";
import { withTracePerception } from "./trace-perception.js";

// A first-write-wins fake with the seal's `created` contract — the announce-once hinge.
function fakeStore(): TrajectoryStore {
  const sealed = new Map<string, { meta: TrajectoryMeta; events: TraceEvent[] }>();
  return {
    async seal(input) {
      const existing = sealed.get(input.runId);
      if (existing) return { ...existing.meta, created: false };
      const meta: TrajectoryMeta = {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: input.events?.length ?? input.spans?.length ?? 0,
        sealedAt: "t",
      };
      sealed.set(input.runId, { meta, events: input.events ?? [] });
      return { ...meta, created: true };
    },
    async get(tenant, runId) {
      const hit = sealed.get(runId);
      if (!hit || hit.meta.tenant !== tenant) return undefined;
      return {
        ...hit,
        segments: [
          {
            emitter: hit.meta.source,
            source: hit.meta.source,
            eventCount: hit.events.length,
            sealedAt: hit.meta.sealedAt,
            format: "events" as const,
            events: hit.events,
          },
        ],
      };
    },
    async list() {
      return { items: [] };
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
    async deleteOlderThan() {
      return 0;
    },
  };
}

function collector() {
  const emitted: EmitPlatformEventInput[] = [];
  const emitter: PlatformEventEmitter = {
    async emit(input) {
      emitted.push(input);
      return undefined;
    },
  };
  return { emitted, emitter };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const expensive: TraceEvent[] = [
  { t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1000, outputTokens: 500, usd: 2.5 } },
  { t: 1, kind: "tool_call", id: "c1", name: "bash", args: {} },
  { t: 2, kind: "tool_result", id: "c1", ok: false, output: "boom" },
];

describe("withTracePerception — the store perceives, the log announces (E4)", () => {
  it("a seal crossing a tenant threshold lands trace.threshold_crossed with the arithmetic in the payload", async () => {
    const { emitted, emitter } = collector();
    const thresholds: TraceThreshold[] = [
      { name: "spendy", metric: "usd", value: 1 },
      { name: "quiet", metric: "llm_calls", value: 10 }, // NOT crossed — one fact per crossed bound only
    ];
    const store = withTracePerception(fakeStore(), { thresholdsFor: async () => thresholds, events: emitter });

    await store.seal({ runId: "run-1", tenant: "acme", source: "otlp", events: expensive });
    await flush();

    expect(emitted).toEqual([
      {
        workspace: "acme",
        kind: "trace.threshold_crossed",
        subject: { type: "run", id: "run-1" },
        payload: { runId: "run-1", threshold: "spendy", metric: "usd", value: 2.5, limit: 1, source: "otlp" },
        message: 'Trace run-1 crossed "spendy" — usd 2.5 > 1',
      },
    ]);
  });

  it("a re-offered seal (created=false) never re-announces — at-least-once callers stay safe", async () => {
    const { emitted, emitter } = collector();
    const store = withTracePerception(fakeStore(), {
      thresholdsFor: async () => [{ name: "spendy", metric: "usd", value: 1 }],
      events: emitter,
    });
    await store.seal({ runId: "run-1", tenant: "acme", source: "run", events: expensive });
    await store.seal({ runId: "run-1", tenant: "acme", source: "run", events: expensive }); // the retry
    await flush();
    expect(emitted).toHaveLength(1);
  });

  it("no thresholds / under the bound → silent; a thresholds-read failure never touches the seal", async () => {
    const { emitted, emitter } = collector();
    const quiet = withTracePerception(fakeStore(), { thresholdsFor: async () => [], events: emitter });
    await quiet.seal({ runId: "r1", tenant: "acme", source: "run", events: expensive });

    const failing = withTracePerception(fakeStore(), {
      thresholdsFor: async () => {
        throw new Error("settings down");
      },
      events: emitter,
    });
    const sealed = await failing.seal({ runId: "r2", tenant: "acme", source: "run", events: expensive });
    await flush();
    expect(sealed.created).toBe(true); // the seal itself is untouched by the perception failure
    expect(emitted).toEqual([]);
  });
});
