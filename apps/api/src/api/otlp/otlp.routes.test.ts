import { type SealedTrajectory, type TrajectoryStore, collectTrajectoryEvents } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { TraceEvent } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryTrajectoryStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { OtlpIngestService } from "../../core/observability/otlp-ingest-service.js";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme", "content-type": "application/json" };

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in OTLP tests");
  },
};

function build() {
  const trajectories = new InMemoryTrajectoryStore();
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    otlpIngest: new OtlpIngestService(trajectories),
  });
  return { app, trajectories };
}

// A standard OTLP/HTTP JSON export: the run id rides the RESOURCE attributes (the injected
// OTEL_RESOURCE_ATTRIBUTES shape), spans carry the gen_ai.* conventions the normalizer already speaks.
const exportBody = (runId: string) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "everdict.run_id", value: { stringValue: runId } }] },
      scopeSpans: [
        {
          spans: [
            {
              name: "llm chat",
              startTimeUnixNano: "1000000000",
              endTimeUnixNano: "2000000000",
              attributes: [
                { key: "gen_ai.request.model", value: { stringValue: "claude-fable-5" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "20" } },
              ],
            },
            {
              name: "tool bash",
              startTimeUnixNano: "2000000000",
              endTimeUnixNano: "3000000000",
              attributes: [{ key: "tool.name", value: { stringValue: "bash" } }],
            },
          ],
        },
      ],
    },
  ],
});

describe("POST /v1/traces — the OTLP door seals the owned trajectory (N0)", () => {
  it("normalizes a standard export by everdict.run_id and seals it (source: otlp)", async () => {
    const { app, trajectories } = build();
    const res = await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-otlp-1") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({}); // OTLP-spec full success
    const sealed = await whole(trajectories, "acme", "run-otlp-1");
    // The ledger counts SPANS now — that is the unit an OTLP door receives (N6). The export carried two.
    expect(sealed?.meta).toMatchObject({ source: "otlp", eventCount: 2 });
    // What a judge reads is unchanged: the two spans project to llm_call + the tool_call/tool_result pair.
    expect(sealed?.events).toHaveLength(3);
    // And the RECORD is what the tenant actually sent — the tree, not a flattening of it.
    expect(sealed?.segments[0]?.format).toBe("spans");
    // The RECORD travels on the page beside the projection — a plane header carries neither.
    const page = await trajectories.events("acme", "run-otlp-1", {});
    expect(page.kind === "page" && page.page.spans).toHaveLength(2);
    expect(sealed?.events.some((e) => e.kind === "llm_call" && "model" in e && e.model === "claude-fable-5")).toBe(
      true,
    );
    expect(sealed?.events.some((e) => e.kind === "tool_call")).toBe(true);
  });

  it("a re-export for an already-sealed run is rejected VISIBLY (partialSuccess) — evidence seals once", async () => {
    const { app } = build();
    await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-otlp-2") });
    const again = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: H,
      payload: exportBody("run-otlp-2"),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().partialSuccess.rejectedSpans).toBe(2);
  });

  it("spans without an everdict.run_id anywhere cannot join the ledger — counted, never silently dropped", async () => {
    const { app, trajectories } = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: H,
      payload: {
        resourceSpans: [
          { resource: { attributes: [] }, scopeSpans: [{ spans: [{ name: "orphan", attributes: [] }] }] },
        ],
      },
    });
    expect(res.json().partialSuccess.rejectedSpans).toBe(1);
    expect(await whole(trajectories, "acme", "")).toBeUndefined();
  });

  it("the N3 admission lane: past the events/hour quota the door refuses at 429 and announces ONCE (cooldown)", async () => {
    const trajectories = new InMemoryTrajectoryStore();
    const emitted: string[] = [];
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      otlpIngest: new OtlpIngestService(trajectories, {
        defaultMaxEventsPerHour: 2,
        events: {
          async emit(input) {
            emitted.push(input.kind);
            return undefined;
          },
        },
      }),
    });

    // First export: 2 spans — exactly at the bound, admitted.
    expect(
      (await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-q1") })).statusCode,
    ).toBe(200);
    // Second export would cross the bound → 429 with the arithmetic, sealed nothing.
    const refused = await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-q2") });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "RATE_LIMITED", data: { usedLastHour: 2, limit: 2 } });
    expect(await whole(trajectories, "acme", "run-q2")).toBeUndefined();
    // The retrying exporter keeps getting 429s but the LOG hears about it once (cooldown).
    await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-q3") });
    expect(emitted).toEqual(["trace.ingestion_throttled"]);
  });

  // ── AN UNREADABLE QUOTA IS NOT "NO OVERRIDE" (rule `protocol` L2, perf review) ────────────────────
  //
  // `quotaFor` was read as `.catch(() => undefined)`, and `undefined` already MEANS "this workspace set no
  // override". So a settings-store outage was indistinguishable from a workspace that had never configured
  // one, and the door then admitted under the operator default — over a workspace that had set a lower
  // ceiling, or throttling one that had raised it. It fails precisely when the database is already unwell.
  //
  // SEEN RED by restoring `.catch(() => undefined)`, observed:
  //   AssertionError: expected 200 to be 502 // Object.is equality
  it("refuses the export when the workspace's quota cannot be read, rather than admitting under a default", async () => {
    // Given: a door whose settings read is failing
    const trajectories = new InMemoryTrajectoryStore();
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      otlpIngest: new OtlpIngestService(trajectories, {
        defaultMaxEventsPerHour: 1_000,
        quotaFor: async () => {
          throw new Error("settings store unreachable");
        },
      }),
    });

    // When: an exporter pushes
    const res = await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-unknown") });

    // Then: the push is refused, and nothing was sealed under a limit nobody chose
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(await whole(trajectories, "acme", "run-unknown")).toBeUndefined();
  });

  // A service under test joins the run's trajectory by setting OTEL_SERVICE_NAME + the run correlation —
  // OTel's own attribute, no everdict-specific convention (the multi-plane rung).
  const serviceExport = (runId: string, service: string, span: string) => ({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "everdict.run_id", value: { stringValue: runId } },
            { key: "service.name", value: { stringValue: service } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                name: span,
                startTimeUnixNano: "5000000000",
                endTimeUnixNano: "5500000000",
                attributes: [{ key: "http.route", value: { stringValue: "/cart" } }],
              },
            ],
          },
        ],
      },
    ],
  });

  it("each emitting SERVICE seals as its own plane — one run, the whole system", async () => {
    const { app, trajectories } = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: H,
      payload: {
        resourceSpans: [
          ...serviceExport("run-sys-1", "checkout", "GET /cart").resourceSpans,
          ...serviceExport("run-sys-1", "payments", "POST /charge").resourceSpans,
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({}); // nothing rejected — a second service is not a duplicate

    const sealed = await whole(trajectories, "acme", "run-sys-1");
    expect(sealed?.segments.map((s) => s.emitter)).toEqual(["service:checkout", "service:payments"]);
    // Each plane carries its own absolute anchor, so a reader can lay them on one time axis.
    expect(sealed?.segments.every((s) => s.t0 !== undefined)).toBe(true);
    expect(sealed?.meta.eventCount).toBe(2);
    // A structural span keeps its own length — without it a service plane would draw as an instant.
    const first = await trajectories.events("acme", "run-sys-1", { emitter: sealed?.segments[0]?.emitter ?? "" });
    expect(first.kind === "page" && first.page.events[0]).toMatchObject({ kind: "span", durationMs: 500 });
  });

  it("a service's spans JOIN an already-sealed run instead of being rejected as a retry", async () => {
    const { app, trajectories } = build();
    await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-sys-2") });
    const joined = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: H,
      payload: serviceExport("run-sys-2", "checkout", "GET /cart"),
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toEqual({}); // admitted — the pre-multi-plane door rejected this span

    const sealed = await whole(trajectories, "acme", "run-sys-2");
    expect(sealed?.segments.map((s) => s.emitter)).toEqual(["otlp", "service:checkout"]);
    // The agent's own record still answers "what did the agent do" — a service never displaces it.
    expect(sealed?.executionEmitter).toBe("otlp");
    expect(sealed?.events).toHaveLength(3);
  });

  it("traces seal into the CALLER's workspace — another tenant cannot read them", async () => {
    const { app, trajectories } = build();
    await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-otlp-3") });
    expect(await whole(trajectories, "acme", "run-otlp-3")).toBeDefined();
    expect(await whole(trajectories, "rival", "run-otlp-3")).toBeUndefined();
  });
});

// A TEST convenience over fixtures of known, small size: the plane headers plus every event, assembled from
// the two production reads. Deliberately NOT a production shape — `collectTrajectoryEvents` is how a caller
// that genuinely needs the whole stream gets it, and what bounds it here is the fixture.
async function whole(
  store: TrajectoryStore,
  tenant: string,
  runId: string,
  opts?: { attemptId: string },
): Promise<(SealedTrajectory & { events: TraceEvent[] }) | undefined> {
  const planes = await store.planes(tenant, runId, opts);
  if (!planes) return undefined;
  return { ...planes, events: await collectTrajectoryEvents(store, tenant, runId, opts ?? {}) };
}
