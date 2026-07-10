import { AppError } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { MlflowTraceSource, parseMlflowTrace } from "./mlflow.js";

// Span shape captured from a real MLflow 3.11.1 `GET /api/3.0/mlflow/traces/get` response (OTLP AnyValue, snake_case).
// Pins the adapter to the real MLflow schema — so CI catches drift even without live infra.
const REAL_TRACE = {
  trace: {
    spans: [
      {
        name: "agent_turn",
        start_time_unix_nano: "1781857437482972027",
        end_time_unix_nano: "1781857438391613917",
        attributes: [
          { key: "mlflow.spanType", value: { string_value: "UNKNOWN" } },
          {
            key: "mlflow.spanInputs",
            value: { kvlist_value: { values: [{ key: "task", value: { string_value: "create ok.txt" } }] } },
          },
          {
            key: "mlflow.spanOutputs",
            value: { kvlist_value: { values: [{ key: "done", value: { bool_value: true } }] } },
          },
        ],
      },
      {
        name: "llm_call",
        start_time_unix_nano: 1781857437600000000,
        end_time_unix_nano: 1781857437601000000,
        attributes: [
          { key: "mlflow.spanType", value: { string_value: "LLM" } },
          { key: "gen_ai.request.model", value: { string_value: "gpt-5.4-mini" } },
        ],
      },
      {
        name: "tool_call",
        start_time_unix_nano: 1781857438000000000,
        end_time_unix_nano: 1781857438100000000,
        attributes: [{ key: "tool.name", value: { string_value: "bash" } }],
      },
    ],
  },
};

describe("parseMlflowTrace (MLflow 3.x OTLP AnyValue)", () => {
  it("flattens the snake_case AnyValue array (string/bool/nested kvlist)", () => {
    const spans = parseMlflowTrace(REAL_TRACE.trace);
    expect(spans).toHaveLength(3);
    const llm = spans.find((s) => s.name === "llm_call");
    expect(llm?.attrs["gen_ai.request.model"]).toBe("gpt-5.4-mini");
    const root = spans.find((s) => s.name === "agent_turn");
    expect(root?.attrs["mlflow.spanInputs"]).toEqual({ task: "create ok.txt" }); // kvlist → object
    expect(root?.attrs["mlflow.spanOutputs"]).toEqual({ done: true }); // bool_value
  });
});

describe("MlflowTraceSource.fetch", () => {
  it("real response shape → normalized to llm_call (model) + tool_call (bash)", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify(REAL_TRACE), { status: 200 })),
    );
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const ev = await src.fetch("tr-abc");
    expect(ev.find((e) => e.kind === "llm_call")).toMatchObject({ model: "gpt-5.4-mini" });
    expect(ev.find((e) => e.kind === "tool_call")).toMatchObject({ name: "bash" });
    // verify the V3 endpoint path
    expect(fetchImpl.mock.calls[0]?.[0] as string).toMatch(/\/api\/3\.0\/mlflow\/traces\/get\?trace_id=tr-abc$/);
  });

  it("404 (trace absent) → [] degrade (service-harness path)", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("not found", { status: 404 })));
    const src = new MlflowTraceSource({ endpoint: "http://m", fetchImpl: fetchImpl as typeof fetch });
    expect(await src.fetch("missing")).toEqual([]);
  });

  it("non-2xx other than 404 (401/5xx etc.) → UpstreamError", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("denied", { status: 401 })));
    const src = new MlflowTraceSource({ endpoint: "http://m", fetchImpl: fetchImpl as typeof fetch });
    await expect(src.fetch("t")).rejects.toBeInstanceOf(AppError);
  });
});

// correlate="tag" — search by the everdict.run_id tag the instrumented agent wrote to its own trace (pinned to the real MLflow 3.14 API shape).
describe("MlflowTraceSource — tag correlation", () => {
  it("finds the trace_id via traces/search (locations + tags.`everdict.run_id` filter), then fetches spans by that id", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      calls.push({ url, body: args[1]?.body as string | undefined });
      if (url.includes("/traces/search"))
        return Promise.resolve(new Response(JSON.stringify({ traces: [{ trace_id: "tr-found" }] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(REAL_TRACE), { status: 200 }));
    });
    const src = new MlflowTraceSource({
      endpoint: "http://m",
      correlate: "tag",
      experimentIds: ["7"],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const events = await src.fetch("everdict-run-1");

    const search = JSON.parse(calls[0]?.body ?? "{}");
    // Real 3.14 verified shape: locations required + backtick tag filter.
    expect(search.locations).toEqual([{ type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: "7" } }]);
    expect(search.filter).toBe("tags.`everdict.run_id` = 'everdict-run-1'");
    expect(calls[1]?.url).toContain("trace_id=tr-found");
    expect(events.some((e) => e.kind === "llm_call")).toBe(true);
  });

  it("tag not found → [] degrade (same as id mode's 404), experiment unset → explicit error (locations required)", async () => {
    const empty = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ traces: [] }), { status: 200 })));
    const src = new MlflowTraceSource({
      endpoint: "http://m",
      correlate: "tag",
      experimentIds: ["7"],
      fetchImpl: empty as typeof fetch,
    });
    expect(await src.fetch("x")).toEqual([]);

    const none = new MlflowTraceSource({ endpoint: "http://m", correlate: "tag", fetchImpl: empty as typeof fetch });
    await expect(none.fetch("x")).rejects.toThrow("experiment");
  });
});
