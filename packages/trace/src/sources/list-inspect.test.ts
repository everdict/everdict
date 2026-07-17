import { describe, expect, it, vi } from "vitest";
import { LangfuseTraceSource } from "./langfuse-source.js";
import { LangsmithTraceSource } from "./langsmith-source.js";
import { MlflowTraceSource } from "./mlflow.js";
import { OtelTraceSource } from "./otel.js";
import { PhoenixTraceSource } from "./phoenix-source.js";
import { spansToRawAttributes, summarizeSpans } from "./trace-source.js";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("summarizeSpans / spansToRawAttributes (pure)", () => {
  it("derives duration/tokens/model from llm spans and exposes raw span attributes", () => {
    const spans = [
      {
        name: "chat",
        startMs: 1000,
        endMs: 2000,
        attrs: { "gen_ai.request.model": "gpt-5", "gen_ai.usage.input_tokens": 12 },
      },
    ];
    const summary = summarizeSpans(spans);
    expect(summary).toMatchObject({ name: "chat", durationMs: 1000, spanCount: 1, llmModel: "gpt-5" });
    expect(summary.tokens?.input).toBe(12);
    expect(spansToRawAttributes(spans)).toEqual([
      { spanName: "chat", attrs: { "gen_ai.request.model": "gpt-5", "gen_ai.usage.input_tokens": 12 } },
    ]);
  });

  it("returns an empty summary for no spans (no silent zeros)", () => {
    expect(summarizeSpans([])).toEqual({});
  });
});

describe("OtelTraceSource — listTraces + inspect (Jaeger)", () => {
  const listBody = {
    data: [
      {
        traceID: "t1",
        spans: [
          {
            operationName: "chat",
            startTime: 1_700_000_000_000_000,
            duration: 1_000_000,
            tags: [
              { key: "gen_ai.request.model", value: "gpt-5.4-mini" },
              { key: "gen_ai.usage.input_tokens", value: 42 },
              { key: "gen_ai.usage.output_tokens", value: 7 },
            ],
          },
        ],
      },
    ],
  };

  it("lists traces from the service scope and summarizes the embedded spans", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(listBody)));
    const src = new OtelTraceSource({ endpoint: "http://jaeger:16686", fetchImpl: fetchImpl as typeof fetch });
    const traces = await src.listTraces({ scope: "svc-a", limit: 25 });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/traces");
    expect(url.searchParams.get("service")).toBe("svc-a");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ id: "t1", llmModel: "gpt-5.4-mini", scope: "svc-a" });
    expect(traces[0]?.tokens).toEqual({ input: 42, output: 7 });
  });

  it("listTraces requires a service scope", async () => {
    const src = new OtelTraceSource({ endpoint: "http://j", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(src.listTraces()).rejects.toThrow("service");
  });

  it("inspect pulls raw spans by id and applies the supplied mapping", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(listBody)));
    const src = new OtelTraceSource({ endpoint: "http://jaeger:16686", fetchImpl: fetchImpl as typeof fetch });
    const result = await src.inspect("t1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://jaeger:16686/api/traces/t1");
    expect(result.rawAttributes?.[0]?.attrs["gen_ai.request.model"]).toBe("gpt-5.4-mini");
    expect(result.events.find((e) => e.kind === "llm_call")).toMatchObject({ model: "gpt-5.4-mini" });
  });
});

describe("MlflowTraceSource — listTraces + inspect", () => {
  it("lists traces from the experiment scope (traces/search) and maps trace-info metrics", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        json({
          traces: [
            {
              trace_id: "tr1",
              request_time: 1_700_000_000_000,
              execution_duration_ms: 1200,
              state: "OK",
              tags: { "everdict.run_id": "r1" },
              trace_metadata: { "mlflow.trace.tokenUsage": JSON.stringify({ input_tokens: 10, output_tokens: 5 }) },
            },
          ],
        }),
      ),
    );
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const traces = await src.listTraces({ scope: "exp1", limit: 10 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/3.0/mlflow/traces/search");
    expect(traces[0]).toMatchObject({ id: "tr1", durationMs: 1200, status: "ok", scope: "exp1" });
    expect(traces[0]?.tokens).toEqual({ input: 10, output: 5 });
    expect(traces[0]?.tags).toEqual({ "everdict.run_id": "r1" });
    expect(traces[0]?.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("maps the MLflow 3.x trace-info shape — proto-JSON execution_duration and the mlflow.traceName tag", async () => {
    // The live 3.x server returns execution_duration as a proto3-JSON Duration string ("1.2s") and the display
    // name only as the mlflow.traceName tag — neither field of the older *_ms shape is present.
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        json({
          traces: [
            {
              trace_id: "tr2",
              request_time: "2026-07-17T01:02:03Z",
              execution_duration: "1.2s",
              state: "ERROR",
              tags: { "mlflow.traceName": "agent-run" },
            },
          ],
        }),
      ),
    );
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const traces = await src.listTraces({ scope: "exp1" });
    expect(traces[0]).toMatchObject({ id: "tr2", name: "agent-run", durationMs: 1200, status: "error" });
    expect(traces[0]?.startedAt).toBe(new Date("2026-07-17T01:02:03Z").toISOString());
  });

  it("listTraces requires an experiment scope", async () => {
    const src = new MlflowTraceSource({ endpoint: "http://m", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(src.listTraces()).rejects.toThrow("experiment");
  });

  it("maps the trace-level total cost from the mlflow.trace.cost metadata (live 3.11 shape)", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        json({
          traces: [
            {
              trace_id: "tr-cost",
              state: "OK",
              trace_metadata: {
                "mlflow.trace.cost": JSON.stringify({ input_cost: 0.0, output_cost: 0.0, total_cost: 0.0012 }),
              },
            },
          ],
        }),
      ),
    );
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const traces = await src.listTraces({ scope: "exp1" });
    expect(traces[0]?.costUsd).toBe(0.0012);
  });

  it("enriches model-less list rows from each trace's spans (TraceInfo never carries the model)", async () => {
    // search returns two model-less rows; the per-trace get responses carry the model in the spans.
    const spansFor = (model: string) => ({
      trace: {
        spans: [
          {
            name: "chat",
            start_time_unix_nano: "1000000",
            end_time_unix_nano: "2000000",
            attributes: [{ key: "mlflow.llm.model", value: { string_value: model } }],
          },
        ],
      },
    });
    const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes("/traces/search"))
        return Promise.resolve(json({ traces: [{ trace_id: "tr-a", state: "OK" }, { trace_id: "tr-b" }] }));
      if (url.includes("trace_id=tr-a")) return Promise.resolve(json(spansFor("gpt-5.4-mini")));
      return Promise.resolve(json(spansFor("claude-fable-5")));
    });
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const traces = await src.listTraces({ scope: "exp1" });
    expect(traces.map((t) => t.llmModel)).toEqual(["gpt-5.4-mini", "claude-fable-5"]);
    // one traces/get per model-less row, after the single search
    const gets = fetchImpl.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/traces/get"));
    expect(gets).toHaveLength(2);
  });

  it("a failed enrichment fetch leaves the row model-less instead of failing the list", async () => {
    const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes("/traces/search")) return Promise.resolve(json({ traces: [{ trace_id: "tr-x", state: "OK" }] }));
      return Promise.resolve(new Response("boom", { status: 500 }));
    });
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const traces = await src.listTraces({ scope: "exp1" });
    expect(traces).toHaveLength(1);
    expect(traces[0]?.llmModel).toBeUndefined();
  });

  it("inspect pulls the trace by id and exposes raw span attributes", async () => {
    const trace = {
      trace: {
        spans: [
          {
            name: "chat",
            start_time_unix_nano: "1000000",
            end_time_unix_nano: "2000000",
            attributes: [{ key: "gen_ai.request.model", value: { string_value: "gpt-x" } }],
          },
        ],
      },
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(trace)));
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const result = await src.inspect("tr1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/3.0/mlflow/traces/get?trace_id=tr1");
    expect(result.rawAttributes?.[0]).toEqual({ spanName: "chat", attrs: { "gen_ai.request.model": "gpt-x" } });
    expect(result.events.find((e) => e.kind === "llm_call")).toMatchObject({ model: "gpt-x" });
  });
});

describe("PhoenixTraceSource — listTraces groups spans by trace_id", () => {
  it("groups the recent project spans into per-trace summaries", async () => {
    const body = {
      data: [
        {
          name: "root",
          context: { trace_id: "t1" },
          span_kind: "LLM",
          start_time: "2026-01-01T00:00:00Z",
          end_time: "2026-01-01T00:00:01Z",
          status_code: "OK",
          attributes: { llm: { model_name: "gpt-4", token_count: { prompt: 8, completion: 3 } } },
        },
        {
          name: "tool",
          context: { trace_id: "t1" },
          span_kind: "TOOL",
          start_time: "2026-01-01T00:00:01Z",
          end_time: "2026-01-01T00:00:02Z",
          status_code: "OK",
        },
      ],
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new PhoenixTraceSource({
      endpoint: "http://phoenix:6006",
      project: "p",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const traces = await src.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ id: "t1", spanCount: 2, status: "ok", llmModel: "gpt-4", scope: "p" });
    expect(traces[0]?.tokens).toEqual({ input: 8, output: 3 });
  });

  it("inspect returns events only (native kind — no raw attributes / mapping)", async () => {
    const body = {
      data: [{ name: "n", context: { trace_id: "t1" }, span_kind: "CHAIN", start_time: "2026-01-01T00:00:00Z" }],
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new PhoenixTraceSource({
      endpoint: "http://phoenix:6006",
      project: "p",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await src.inspect("t1");
    expect(result.rawAttributes).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);
  });
});

describe("LangfuseTraceSource — listTraces", () => {
  it("lists traces and maps latency(s)→ms, cost and tags", async () => {
    const body = {
      data: [
        { id: "lf1", name: "agent", timestamp: "2026-01-01T00:00:00Z", latency: 2.5, totalCost: 0.03, tags: ["prod"] },
      ],
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new LangfuseTraceSource({ endpoint: "http://langfuse:3000", fetchImpl: fetchImpl as typeof fetch });
    const traces = await src.listTraces({ limit: 20 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/public/traces?");
    expect(traces[0]).toMatchObject({ id: "lf1", name: "agent", durationMs: 2500, costUsd: 0.03 });
    expect(traces[0]?.tags).toEqual({ prod: "" });
  });
});

describe("LangsmithTraceSource — listTraces (root runs)", () => {
  it("lists root runs of a session and maps tokens/cost/status", async () => {
    const body = {
      runs: [
        {
          id: "r1",
          trace_id: "t1",
          name: "root",
          run_type: "chain",
          start_time: "2026-01-01T00:00:00Z",
          end_time: "2026-01-01T00:00:01Z",
          prompt_tokens: 10,
          completion_tokens: 5,
          total_cost: "0.01",
        },
      ],
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new LangsmithTraceSource({
      endpoint: "https://api.smith.langchain.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const traces = await src.listTraces({ scope: "sess1" });
    expect(traces[0]).toMatchObject({ id: "t1", durationMs: 1000, status: "ok", costUsd: 0.01, scope: "sess1" });
    expect(traces[0]?.tokens).toEqual({ input: 10, output: 5 });
  });

  it("listTraces requires a session (project) scope", async () => {
    const src = new LangsmithTraceSource({ endpoint: "https://x", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(src.listTraces()).rejects.toThrow("project");
  });
});
