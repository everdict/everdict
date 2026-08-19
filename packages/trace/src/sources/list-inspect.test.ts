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
    const { traces } = await src.listTraces({ scope: "svc-a", limit: 25 });
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

  it("passes the time window as start/end microseconds (Jaeger query API)", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(listBody)));
    const src = new OtelTraceSource({ endpoint: "http://jaeger:16686", fetchImpl: fetchImpl as typeof fetch });
    const since = "2026-07-01T00:00:00.000Z";
    const until = "2026-07-02T00:00:00.000Z";
    await src.listTraces({ scope: "svc-a", since, until });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("start")).toBe(String(Date.parse(since) * 1000));
    expect(url.searchParams.get("end")).toBe(String(Date.parse(until) * 1000));
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
    const { traces } = await src.listTraces({ scope: "exp1", limit: 10 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/3.0/mlflow/traces/search");
    expect(traces[0]).toMatchObject({ id: "tr1", durationMs: 1200, status: "ok", scope: "exp1" });
    expect(traces[0]?.tokens).toEqual({ input: 10, output: 5 });
    expect(traces[0]?.tags).toEqual({ "everdict.run_id": "r1" });
    expect(traces[0]?.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("passes the time window as a timestamp_ms filter on traces/search", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json({ traces: [] })));
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const since = "2026-07-01T00:00:00.000Z";
    const until = "2026-07-02T00:00:00.000Z";
    await src.listTraces({ scope: "exp1", since, until });
    const req = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(req.filter).toBe(`timestamp_ms >= ${Date.parse(since)} AND timestamp_ms <= ${Date.parse(until)}`);
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
    const { traces } = await src.listTraces({ scope: "exp1" });
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
    const { traces } = await src.listTraces({ scope: "exp1" });
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
    const { traces } = await src.listTraces({ scope: "exp1" });
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
    const { traces } = await src.listTraces({ scope: "exp1" });
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
    const { traces } = await src.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ id: "t1", spanCount: 2, status: "ok", llmModel: "gpt-4", scope: "p" });
    expect(traces[0]?.tokens).toEqual({ input: 8, output: 3 });
  });

  it("passes the time window as start_time/end_time on the spans endpoint", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json({ data: [] })));
    const src = new PhoenixTraceSource({
      endpoint: "http://phoenix:6006",
      project: "p",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await src.listTraces({ since: "2026-07-01T00:00:00.000Z", until: "2026-07-02T00:00:00.000Z" });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("start_time")).toBe("2026-07-01T00:00:00.000Z");
    expect(url.searchParams.get("end_time")).toBe("2026-07-02T00:00:00.000Z");
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
    const { traces } = await src.listTraces({ limit: 20 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/public/traces?");
    expect(traces[0]).toMatchObject({ id: "lf1", name: "agent", durationMs: 2500, costUsd: 0.03 });
    expect(traces[0]?.tags).toEqual({ prod: "" });
  });

  it("passes the time window as fromTimestamp/toTimestamp", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json({ data: [] })));
    const src = new LangfuseTraceSource({ endpoint: "http://langfuse:3000", fetchImpl: fetchImpl as typeof fetch });
    await src.listTraces({ since: "2026-07-01T00:00:00.000Z", until: "2026-07-02T00:00:00.000Z" });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("fromTimestamp")).toBe("2026-07-01T00:00:00.000Z");
    expect(url.searchParams.get("toTimestamp")).toBe("2026-07-02T00:00:00.000Z");
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
    const { traces } = await src.listTraces({ scope: "sess1" });
    expect(traces[0]).toMatchObject({ id: "t1", durationMs: 1000, status: "ok", costUsd: 0.01, scope: "sess1" });
    expect(traces[0]?.tokens).toEqual({ input: 10, output: 5 });
  });

  it("passes the time window as a start_time filter DSL on /runs/query", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json({ runs: [] })));
    const src = new LangsmithTraceSource({
      endpoint: "https://api.smith.langchain.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const since = "2026-07-01T00:00:00.000Z";
    const until = "2026-07-02T00:00:00.000Z";
    await src.listTraces({ scope: "sess1", since, until });
    const req = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(req.filter).toBe(`and(gte(start_time, "${since}"), lte(start_time, "${until}"))`);
  });

  it("listTraces requires a session (project) scope", async () => {
    const src = new LangsmithTraceSource({ endpoint: "https://x", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(src.listTraces()).rejects.toThrow("project");
  });
});

describe("trace list pagination (cursor → nextCursor)", () => {
  it("MlflowTraceSource threads page_token and surfaces next_page_token as nextCursor", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        json({ traces: [{ trace_id: "tr1", state: "OK", tags: { "mlflow.llm.model": "x" } }], next_page_token: "pt2" }),
      ),
    );
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const page = await src.listTraces({ scope: "exp1", cursor: "pt1" });
    expect(page.nextCursor).toBe("pt2");
    const req = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(req.page_token).toBe("pt1");
  });

  it("MlflowTraceSource omits nextCursor when the search returns no page token (last page)", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(json({ traces: [{ trace_id: "tr1", state: "OK", tags: { "mlflow.llm.model": "x" } }] })),
    );
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    expect((await src.listTraces({ scope: "exp1" })).nextCursor).toBeUndefined();
  });

  it("LangfuseTraceSource pages by number and reports the next page as nextCursor", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(json({ data: [{ id: "lf1" }], meta: { totalPages: 3 } })),
    );
    const src = new LangfuseTraceSource({ endpoint: "http://langfuse:3000", fetchImpl: fetchImpl as typeof fetch });
    const page = await src.listTraces({ cursor: "2", limit: 10 });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("page")).toBe("2");
    expect(page.nextCursor).toBe("3"); // page 2 of 3 → next is 3
  });

  it("LangfuseTraceSource omits nextCursor on the last page (totalPages reached)", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(json({ data: [{ id: "lf1" }], meta: { totalPages: 2 } })),
    );
    const src = new LangfuseTraceSource({ endpoint: "http://langfuse:3000", fetchImpl: fetchImpl as typeof fetch });
    expect((await src.listTraces({ cursor: "2", limit: 10 })).nextCursor).toBeUndefined();
  });

  it("LangfuseTraceSource infers a next page from a full page when meta is absent", async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({ id: `lf${i}` }));
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json({ data })));
    const src = new LangfuseTraceSource({ endpoint: "http://langfuse:3000", fetchImpl: fetchImpl as typeof fetch });
    expect((await src.listTraces({ limit: 10 })).nextCursor).toBe("2"); // full page 1 ⇒ maybe more ⇒ page 2
  });

  it("LangsmithTraceSource threads cursor and returns cursors.next as nextCursor", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(json({ runs: [{ trace_id: "t1", name: "root", run_type: "chain" }], cursors: { next: "c2" } })),
    );
    const src = new LangsmithTraceSource({
      endpoint: "https://api.smith.langchain.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const page = await src.listTraces({ scope: "sess1", cursor: "c1" });
    expect(page.nextCursor).toBe("c2");
    const req = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(req.cursor).toBe("c1");
  });

  it("OtelTraceSource returns a single page with no nextCursor (Jaeger find-traces has no cursor)", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json({ data: [] })));
    const src = new OtelTraceSource({ endpoint: "http://jaeger:16686", fetchImpl: fetchImpl as typeof fetch });
    expect((await src.listTraces({ scope: "svc-a" })).nextCursor).toBeUndefined();
  });

  it("PhoenixTraceSource returns a single best-effort page with no nextCursor", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json({ data: [] })));
    const src = new PhoenixTraceSource({
      endpoint: "http://phoenix:6006",
      project: "p",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect((await src.listTraces()).nextCursor).toBeUndefined();
  });
});

// A browse row that reads `<generic name> <uuid>` is a row nobody can pick out of twenty siblings. Each
// platform already reports what its trace was ASKED to do — these assert we read it instead of dropping it.
describe("a browse row says what the trace was asked to do (every source kind)", () => {
  it("otel/jaeger reads the PROCESS tags, where the resource attributes actually live", async () => {
    // Given a Jaeger doc whose everdict.run_id + service.name sit in `processes`, not on the span
    const body = {
      data: [
        {
          traceID: "t1",
          processes: {
            p1: {
              serviceName: "checkout-agent",
              tags: [
                { key: "everdict.run_id", value: "run-77" },
                { key: "deployment.environment", value: "prod" },
              ],
            },
          },
          spans: [
            {
              operationName: "invoke_agent default",
              processID: "p1",
              startTime: 1_700_000_000_000_000,
              duration: 1_000_000,
              tags: [{ key: "otel.status_code", value: "ERROR" }],
            },
            {
              operationName: "checkout.submit",
              processID: "p1",
              startTime: 1_700_000_000_500_000,
              duration: 200_000,
              tags: [],
            },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new OtelTraceSource({ endpoint: "http://jaeger:16686", fetchImpl: fetchImpl as typeof fetch });
    // When the service scope is listed
    const { traces } = await src.listTraces({ scope: "checkout-agent" });
    // Then the row carries its origin, its service and its failure — none of which a span's own tags hold
    expect(traces[0]?.provenance).toEqual({ runId: "run-77" });
    expect(traces[0]?.tags).toMatchObject({ "service.name": "checkout-agent", "deployment.environment": "prod" });
    expect(traces[0]?.status).toBe("error");
    // …and it is named by the work, not by the agent every sibling row also ran
    expect(traces[0]?.preview).toBe("checkout.submit");
  });

  it("mlflow quotes request_preview — the field its own trace list shows as the row summary", async () => {
    const body = {
      traces: [
        {
          trace_id: "tr-1",
          request_time: 1_700_000_000_000,
          request_preview: '{"messages":[{"role":"user","content":"analyze the failing payment logs"}]}',
          tags: { "mlflow.user": "kim", "mlflow.trace.session": "conv-9" },
        },
      ],
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const { traces } = await src.listTraces({ scope: "exp1" });
    // The chat envelope is unwrapped: a row reading `{"messages":[{"role":…` is the uuid problem again
    expect(traces[0]?.preview).toBe("analyze the failing payment logs");
    expect(traces[0]).toMatchObject({ userId: "kim", sessionId: "conv-9" });
  });

  it("langfuse reads the input/user/session/metadata the list already returns", async () => {
    const body = {
      data: [
        {
          id: "lf-1",
          name: "agent",
          timestamp: "2026-08-12T00:00:00.000Z",
          input: { messages: [{ role: "user", content: "draft the release notes" }] },
          userId: "kim",
          sessionId: "conv-9",
          // Our OWN sink writes provenance here — the list path used to drop it, so an everdict-exported
          // trace browsed with no origin while the inspect dialog for the same trace showed one.
          metadata: { scorecardId: "sc-8821", dataset: "travel-v2", caseId: "case-03" },
          observations: ["o1", "o2", "o3"],
          level: "ERROR",
        },
      ],
      meta: { totalPages: 1 },
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new LangfuseTraceSource({
      endpoint: "https://cloud.langfuse.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const { traces } = await src.listTraces();
    expect(traces[0]).toMatchObject({
      preview: "draft the release notes",
      userId: "kim",
      sessionId: "conv-9",
      spanCount: 3,
      status: "error",
      provenance: { scorecardId: "sc-8821", dataset: "travel-v2", caseId: "case-03" },
    });
  });

  it("langfuse accepts metadata as a JSON string too (some servers serialize it)", async () => {
    const body = {
      data: [{ id: "lf-2", metadata: JSON.stringify({ runId: "run-5" }), input: "hello" }],
      meta: { totalPages: 1 },
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new LangfuseTraceSource({
      endpoint: "https://cloud.langfuse.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const { traces } = await src.listTraces();
    expect(traces[0]?.provenance).toEqual({ runId: "run-5" });
  });

  it("langsmith quotes the `inputs` it was already fetching for provenance, and selects tags", async () => {
    const body = {
      runs: [
        {
          trace_id: "ls-1",
          name: "AgentExecutor",
          inputs: { input: "find a flight to jeju" },
          tags: ["nightly", "v2"],
          extra: { metadata: { user_id: "kim", session_id: "conv-9" } },
        },
      ],
      cursors: {},
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new LangsmithTraceSource({
      endpoint: "https://api.smith.langchain.com",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const { traces } = await src.listTraces({ scope: "sess1" });
    expect(traces[0]).toMatchObject({
      preview: "find a flight to jeju",
      userId: "kim",
      sessionId: "conv-9",
      tags: { nightly: "", v2: "" },
    });
    // the field has to be asked for, or the server never sends it
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).select).toContain("tags");
  });

  it("phoenix reads the ROOT span's input.value, not whichever nested span came first", async () => {
    const body = {
      data: [
        {
          name: "AgentRun",
          context: { trace_id: "px-1", span_id: "s1" },
          span_kind: "CHAIN",
          start_time: "2026-08-12T00:00:00.000Z",
          end_time: "2026-08-12T00:00:05.000Z",
          status_code: "OK",
          attributes: { input: { value: "book a hotel in busan" }, session: { id: "conv-9" }, user: { id: "kim" } },
        },
        {
          name: "ChatCompletion",
          context: { trace_id: "px-1", span_id: "s2" },
          span_kind: "LLM",
          start_time: "2026-08-12T00:00:01.000Z",
          end_time: "2026-08-12T00:00:04.000Z",
          status_code: "OK",
          attributes: { input: { value: "system: you are a travel agent" } },
        },
      ],
    };
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(json(body)));
    const src = new PhoenixTraceSource({
      endpoint: "http://phoenix:6006",
      project: "p",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const { traces } = await src.listTraces();
    expect(traces[0]).toMatchObject({ preview: "book a hotel in busan", userId: "kim", sessionId: "conv-9" });
  });
});
