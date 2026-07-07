import { AppError } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { buildTraceSource } from "./build-source.js";
import { LangfuseTraceSource } from "./langfuse-source.js";
import { LangsmithTraceSource } from "./langsmith-source.js";
import { PhoenixTraceSource, phoenixSpansToTraceEvents } from "./phoenix-source.js";

// A sequential-response fetch fake — records calls + returns prepared Responses in order (default 200 {}).
function fakeFetch(responses: Response[] = []) {
  let i = 0;
  const impl = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(responses[i++] ?? new Response("{}", { status: 200 })),
  );
  const call = (n: number): { url: string; init: RequestInit } => {
    const c = impl.mock.calls[n];
    if (!c) throw new Error(`no fetch call ${n}`);
    return { url: String(c[0]), init: c[1] ?? {} };
  };
  return { impl: impl as unknown as typeof fetch, call, count: () => impl.mock.calls.length };
}

describe("LangfuseTraceSource", () => {
  const DETAIL = {
    id: "trace_abc",
    observations: [
      {
        type: "GENERATION",
        name: "llm-call",
        startTime: "2026-07-06T09:00:01.000Z",
        endTime: "2026-07-06T09:00:04.000Z",
        model: "gpt-4o",
        usage: { input: 999, output: 999 }, // deprecated — usageDetails must take precedence
        usageDetails: { input: 1200, output: 300, total: 1500 },
        costDetails: { input: 0.012, output: 0.009, total: 0.021 },
        level: "DEFAULT",
      },
      {
        type: "TOOL",
        name: "bash",
        startTime: "2026-07-06T09:00:00.000Z",
        endTime: "2026-07-06T09:00:00.500Z",
        output: "done",
        level: "DEFAULT",
      },
      { type: "SPAN", name: "structural span (skipped)", startTime: "2026-07-06T09:00:02.000Z", level: "DEFAULT" },
    ],
  };

  it("normalizes GET /api/public/traces/{id} observations — usageDetails first, TOOL→tool pair, structural spans skipped", async () => {
    const ff = fakeFetch([new Response(JSON.stringify(DETAIL), { status: 200 })]);
    const src = new LangfuseTraceSource({ endpoint: "https://lf", auth: "Basic cGs6c2s=", fetchImpl: ff.impl });
    const trace = await src.fetch("trace_abc");
    expect(ff.call(0).url).toBe("https://lf/api/public/traces/trace_abc");
    expect((ff.call(0).init.headers as Record<string, string>).authorization).toBe("Basic cGs6c2s=");
    const llm = trace.find((e) => e.kind === "llm_call");
    expect(llm?.kind === "llm_call" && llm.model).toBe("gpt-4o");
    expect(llm?.kind === "llm_call" && llm.cost).toEqual({ inputTokens: 1200, outputTokens: 300, usd: 0.021 });
    expect(llm?.kind === "llm_call" && llm.latencyMs).toBe(3000);
    // The TOOL observation is earliest so t=0, emitted as a tool_call/result pair.
    expect(trace.filter((e) => e.kind === "tool_call" || e.kind === "tool_result")).toHaveLength(2);
    expect(
      trace.filter((e) => e.kind === "llm_call" || e.kind === "tool_call" || e.kind === "tool_result"),
    ).toHaveLength(3);
  });

  it("404 → [] (trace-absent degrade) · non-2xx → UpstreamError", async () => {
    const notFound = new LangfuseTraceSource({
      endpoint: "https://lf",
      fetchImpl: fakeFetch([new Response("no", { status: 404 })]).impl,
    });
    expect(await notFound.fetch("t")).toEqual([]);
    const denied = new LangfuseTraceSource({
      endpoint: "https://lf",
      fetchImpl: fakeFetch([new Response("no", { status: 401 })]).impl,
    });
    await expect(denied.fetch("t")).rejects.toBeInstanceOf(AppError);
  });
});

describe("LangsmithTraceSource", () => {
  it("gathers all runs via a POST /runs/query {trace} + x-api-key + cursors.next loop and normalizes", async () => {
    const page1 = {
      runs: [
        {
          id: "r-llm",
          name: "ChatAnthropic",
          run_type: "llm",
          start_time: "2026-07-06T09:00:01.000Z",
          end_time: "2026-07-06T09:00:02.000Z",
          prompt_tokens: 100,
          completion_tokens: 50,
          total_cost: "0.00342", // decimal string
          extra: { metadata: { ls_model_name: "claude-sonnet-4" } },
        },
      ],
      cursors: { next: "cur-2" },
    };
    const page2 = {
      runs: [
        {
          id: "r-tool",
          name: "bash",
          run_type: "tool",
          start_time: "2026-07-06T09:00:00.000Z",
          end_time: "2026-07-06T09:00:00.300Z",
          outputs: { stdout: "ok" },
        },
        { id: "r-chain", name: "root", run_type: "chain", start_time: "2026-07-06T09:00:00.000Z" },
      ],
      cursors: { next: null },
    };
    const ff = fakeFetch([
      new Response(JSON.stringify(page1), { status: 200 }),
      new Response(JSON.stringify(page2), { status: 200 }),
    ]);
    const src = new LangsmithTraceSource({
      endpoint: "https://api.smith.langchain.com",
      auth: "lsv2_x",
      fetchImpl: ff.impl,
    });
    const trace = await src.fetch("9c1e1a05-0000-4000-8000-000000000001");
    expect(ff.count()).toBe(2); // cursor loop, 2 pages
    expect(ff.call(0).url).toBe("https://api.smith.langchain.com/runs/query");
    expect((ff.call(0).init.headers as Record<string, string>)["x-api-key"]).toBe("lsv2_x");
    const body1 = JSON.parse(String(ff.call(0).init.body)) as Record<string, unknown>;
    expect(body1.trace).toBe("9c1e1a05-0000-4000-8000-000000000001");
    expect(JSON.parse(String(ff.call(1).init.body)).cursor).toBe("cur-2");
    // llm run: model from ls_model_name metadata, cost parsed from the decimal string.
    const llm = trace.find((e) => e.kind === "llm_call");
    expect(llm?.kind === "llm_call" && llm.model).toBe("claude-sonnet-4");
    expect(llm?.kind === "llm_call" && llm.cost?.usd).toBeCloseTo(0.00342);
    // tool run → pair, chain (structural) run → skipped.
    expect(trace.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(
      trace.filter((e) => e.kind === "llm_call" || e.kind === "tool_call" || e.kind === "tool_result"),
    ).toHaveLength(3);
  });
});

describe("PhoenixTraceSource", () => {
  const SPANS = {
    data: [
      {
        name: "ChatCompletion",
        context: { trace_id: "a".repeat(32), span_id: "1a2b3c4d5e6f7a8b" },
        span_kind: "LLM",
        start_time: "2026-07-06T09:00:01.000+00:00",
        end_time: "2026-07-06T09:00:03.000+00:00",
        status_code: "OK",
        // The read side has 'nested' attributes — must parse even without flat dotted keys.
        attributes: { llm: { model_name: "gpt-4o", token_count: { prompt: 1200, completion: 300 } } },
      },
      {
        name: "bash",
        context: { trace_id: "a".repeat(32), span_id: "2b3c4d5e6f7a8b9c" },
        span_kind: "TOOL",
        start_time: "2026-07-06T09:00:00.000+00:00",
        end_time: "2026-07-06T09:00:00.400+00:00",
        status_code: "ERROR",
        status_message: "exit 1",
        attributes: {},
      },
      {
        name: "root",
        context: { trace_id: "a".repeat(32), span_id: "3c4d5e6f7a8b9c0d" },
        span_kind: "CHAIN",
        start_time: "2026-07-06T09:00:00.000+00:00",
        end_time: "2026-07-06T09:00:03.000+00:00",
        status_code: "OK",
        attributes: {},
      },
    ],
    next_cursor: null,
  };

  it("fetches spans via GET /v1/projects/{p}/spans?trace_id= and normalizes (nested attributes + ERROR→ok:false)", async () => {
    const ff = fakeFetch([new Response(JSON.stringify(SPANS), { status: 200 })]);
    const src = new PhoenixTraceSource({
      endpoint: "http://phoenix:6006",
      auth: "Bearer px",
      project: "everdict",
      fetchImpl: ff.impl,
    });
    const trace = await src.fetch("a".repeat(32));
    expect(ff.call(0).url).toBe(`http://phoenix:6006/v1/projects/everdict/spans?trace_id=${"a".repeat(32)}&limit=1000`);
    expect((ff.call(0).init.headers as Record<string, string>).authorization).toBe("Bearer px");
    const llm = trace.find((e) => e.kind === "llm_call");
    expect(llm?.kind === "llm_call" && llm.model).toBe("gpt-4o");
    expect(llm?.kind === "llm_call" && llm.cost?.inputTokens).toBe(1200);
    const result = trace.find((e) => e.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.ok).toBe(false); // status_code ERROR
    expect(result?.kind === "tool_result" && result.output).toBe("exit 1");
  });

  it("project unset → an honest UpstreamError (no silent empty result)", async () => {
    const src = new PhoenixTraceSource({ endpoint: "http://px", fetchImpl: fakeFetch().impl });
    await expect(src.fetch("a".repeat(32))).rejects.toBeInstanceOf(AppError);
  });

  it("phoenixSpansToTraceEvents: normalizes flat dotted keys (the write shape) identically (both-directions defensive)", () => {
    const trace = phoenixSpansToTraceEvents([
      {
        name: "llm",
        span_kind: "LLM",
        start_time: "2026-07-06T09:00:00.000+00:00",
        end_time: "2026-07-06T09:00:01.000+00:00",
        attributes: { "llm.model_name": "m", "llm.token_count.prompt": 10, "llm.token_count.completion": 2 },
      },
    ]);
    expect(trace[0]?.kind === "llm_call" && trace[0].cost?.inputTokens).toBe(10);
  });
});

describe("buildTraceSource — newer kind assembly", () => {
  it("assembles the langfuse/langsmith/phoenix kinds into adapters, and inherits headers.authorization as the auth value", async () => {
    expect(buildTraceSource({ kind: "langfuse", endpoint: "http://l" })).toBeInstanceOf(LangfuseTraceSource);
    expect(buildTraceSource({ kind: "langsmith", endpoint: "http://s" })).toBeInstanceOf(LangsmithTraceSource);
    expect(buildTraceSource({ kind: "phoenix", endpoint: "http://p", project: "a" })).toBeInstanceOf(
      PhoenixTraceSource,
    );
    // The existing pull path injects only via headers.authorization — langsmith must place it as x-api-key.
    const ff = fakeFetch([new Response(JSON.stringify({ runs: [], cursors: { next: null } }), { status: 200 })]);
    const src = buildTraceSource({
      kind: "langsmith",
      endpoint: "https://ls",
      headers: { authorization: "lsv2_from_secret" },
      fetchImpl: ff.impl,
    });
    await src.fetch("t-1");
    expect((ff.call(0).init.headers as Record<string, string>)["x-api-key"]).toBe("lsv2_from_secret");
  });
});
