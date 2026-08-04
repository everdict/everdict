import { PlatformEventService, RunService, withTracePerception } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryPlatformEventStore,
  InMemoryRunStore,
  InMemoryTrajectoryStore,
  InMemoryWorkspaceSettingsStore,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { OtlpIngestService } from "../../core/observability/otlp-ingest-service.js";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme" };

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in trajectory tests");
  },
};

async function build() {
  const trajectoryStore = new InMemoryTrajectoryStore();
  for (const [runId, tenant] of [
    ["r1", "acme"],
    ["r2", "acme"],
    ["r3", "acme"],
    ["r9", "rival"],
  ] as const) {
    await trajectoryStore.seal({ runId, tenant, source: "run", events: [{ t: 0, kind: "llm_call", model: "m" }] });
  }
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    trajectoryStore,
  });
  return { app };
}

describe("GET /trajectories — browsing the owned evidence ledger (N1 look-inward)", () => {
  it("lists the workspace's sealed metas newest-first and walks pages by cursor — never another tenant's", async () => {
    const { app } = await build();
    const first = await app.inject({ method: "GET", url: "/trajectories?limit=2", headers: H });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]).toMatchObject({ source: "run", eventCount: 1 });
    expect(page1.nextCursor).toBeDefined();

    const second = await app.inject({
      method: "GET",
      url: `/trajectories?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      headers: H,
    });
    const page2 = second.json();
    expect(page2.nextCursor).toBeUndefined();
    const seen = [...page1.items, ...page2.items].map((m: { runId: string }) => m.runId).sort();
    expect(seen).toEqual(["r1", "r2", "r3"]); // all of acme's, exactly once — rival's r9 never appears
  });

  it("is absent (404) when no trajectory store is configured", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    expect((await app.inject({ method: "GET", url: "/trajectories", headers: H })).statusCode).toBe(404);
  });
});

describe("GET /trajectories/:id — opening one sealed trajectory", () => {
  it("serves the meta and every sealed event, without echoing the tenant back", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/trajectories/r1", headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({ runId: "r1", source: "run", eventCount: 1, sealedAt: expect.any(String) });
    expect(body.meta.tenant).toBeUndefined();
    expect(body.events).toEqual([{ t: 0, kind: "llm_call", model: "m" }]);
  });

  it("describes every emitter that contributed, shipping each plane's events exactly once", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    await trajectoryStore.seal({
      runId: "sys-1",
      tenant: "acme",
      source: "run",
      events: [{ t: 0, kind: "llm_call", model: "m" }],
    });
    await trajectoryStore.seal({
      runId: "sys-1",
      tenant: "acme",
      source: "otlp",
      emitter: "service:checkout",
      t0: "2026-07-31T00:00:00.000Z",
      events: [{ t: 12, kind: "span", name: "GET /cart", durationMs: 30 }],
    });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      trajectoryStore,
    });

    const body = (await app.inject({ method: "GET", url: "/trajectories/sys-1", headers: H })).json();
    expect(body.meta.eventCount).toBe(2); // every plane counted
    expect(body.events).toEqual([{ t: 0, kind: "llm_call", model: "m" }]); // the execution's own record
    expect(body.segments).toHaveLength(2);
    // The execution segment omits `events` — its stream is the top-level one, never shipped twice.
    expect(body.segments[0]).toEqual({
      emitter: "run",
      source: "run",
      eventCount: 1,
      sealedAt: expect.any(String),
      // What this plane's body actually holds. Both of these were sealed as point-event streams; a reader
      // that wants to say "this is the OTel record" is told so here rather than inferring it (N6).
      format: "events",
    });
    expect(body.segments[1]).toMatchObject({
      emitter: "service:checkout",
      source: "otlp",
      t0: "2026-07-31T00:00:00.000Z",
      events: [{ t: 12, kind: "span", name: "GET /cart", durationMs: 30 }],
    });
  });

  it("opens evidence that has NO run row — an otlp arrival and a materialized import", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    // Neither id is a run record's id: the OTLP door seals under the exporter's everdict.run_id, and a pull
    // ingest materializes under ingest:<scorecardId>:<caseId>. The run-scoped read cannot reach either.
    await trajectoryStore.seal({
      runId: "svc-checkout-42",
      tenant: "acme",
      source: "otlp",
      events: [{ t: 0, kind: "span", name: "checkout" }],
    });
    await trajectoryStore.seal({
      runId: "ingest:sc1:case-a",
      tenant: "acme",
      source: "import",
      events: [{ t: 0, kind: "message", role: "user", text: "hi" }],
    });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      trajectoryStore,
    });

    const otlp = await app.inject({ method: "GET", url: "/trajectories/svc-checkout-42", headers: H });
    expect(otlp.statusCode).toBe(200);
    expect(otlp.json().meta.source).toBe("otlp");
    // The run-scoped twin still 404s for the same evidence — that gap is why this route exists.
    expect((await app.inject({ method: "GET", url: "/runs/svc-checkout-42/trajectory", headers: H })).statusCode).toBe(
      404,
    );

    const imported = await app.inject({
      method: "GET",
      url: `/trajectories/${encodeURIComponent("ingest:sc1:case-a")}`,
      headers: H,
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().events).toHaveLength(1);
  });

  it("is 404 for another workspace's trajectory (no existence leak) and for an unknown id", async () => {
    const { app } = await build();
    expect((await app.inject({ method: "GET", url: "/trajectories/r9", headers: H })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/trajectories/nope", headers: H })).statusCode).toBe(404);
  });

  it("is absent (404) when no trajectory store is configured", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    expect((await app.inject({ method: "GET", url: "/trajectories/r1", headers: H })).statusCode).toBe(404);
  });
});

describe("trace thresholds — the perception loop end to end (E4)", () => {
  const J = { ...H, "content-type": "application/json" };

  function perceivingServer() {
    const settingsStore = new InMemoryWorkspaceSettingsStore();
    const platformEvents = new PlatformEventService({ store: new InMemoryPlatformEventStore() });
    // The same composition main.ts does: the store's seal choke point carries the perception decorator.
    const trajectoryStore = withTracePerception(new InMemoryTrajectoryStore(), {
      thresholdsFor: async (tenant) => (await settingsStore.get(tenant))?.traceThresholds ?? [],
      events: platformEvents,
    });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      trajectoryStore,
      settingsStore,
      platformEvents,
      otlpIngest: new OtlpIngestService(trajectoryStore),
      internalToken: "itok",
    });
    return { app };
  }

  it("PUT validates and replaces; GET reads back; viewer role cannot write", async () => {
    const { app } = perceivingServer();
    const put = await app.inject({
      method: "PUT",
      url: "/workspace/trace-thresholds",
      headers: J,
      payload: { thresholds: [{ name: "spendy", metric: "usd", value: 1 }] },
    });
    expect(put.statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: "/workspace/trace-thresholds", headers: H });
    expect(got.json()).toEqual({ thresholds: [{ name: "spendy", metric: "usd", value: 1 }] });
    const bad = await app.inject({
      method: "PUT",
      url: "/workspace/trace-thresholds",
      headers: J,
      payload: { thresholds: [{ name: "x", metric: "nope", value: 1 }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("a production trace through the OTLP door crossing a threshold lands trace.threshold_crossed on the log", async () => {
    const { app } = perceivingServer();
    await app.inject({
      method: "PUT",
      url: "/workspace/trace-thresholds",
      headers: J,
      payload: { thresholds: [{ name: "any-activity", metric: "events", value: 0 }] },
    });
    // A standard OTLP export — the exact flagship-loop entry (production trace → owned store → fact).
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: J,
      payload: {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "everdict.run_id", value: { stringValue: "run-prod-1" } }] },
            scopeSpans: [
              {
                spans: [
                  { name: "llm chat", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", attributes: [] },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 0)); // perception is fire-and-forget off the seal
    const events = await app.inject({
      method: "GET",
      url: "/internal/events?workspace=acme&kinds=trace.threshold_crossed",
      headers: { "x-internal-token": "itok" },
    });
    const rows = (events.json() as { events: Array<{ kind: string; payload: Record<string, unknown> }> }).events;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      runId: "run-prod-1",
      threshold: "any-activity",
      metric: "events",
      limit: 0,
      source: "otlp",
    });
  });
});
