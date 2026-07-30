import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
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
    const sealed = await trajectories.get("acme", "run-otlp-1");
    expect(sealed?.meta).toMatchObject({ source: "otlp", eventCount: 3 }); // llm_call + tool_call/tool_result pair
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
    expect(await trajectories.get("acme", "")).toBeUndefined();
  });

  it("traces seal into the CALLER's workspace — another tenant cannot read them", async () => {
    const { app, trajectories } = build();
    await app.inject({ method: "POST", url: "/v1/traces", headers: H, payload: exportBody("run-otlp-3") });
    expect(await trajectories.get("acme", "run-otlp-3")).toBeDefined();
    expect(await trajectories.get("rival", "run-otlp-3")).toBeUndefined();
  });
});
