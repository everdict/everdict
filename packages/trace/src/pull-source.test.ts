import { AppError } from "@assay/core";
import { describe, expect, it, vi } from "vitest";
import { buildTraceSource } from "./build-source.js";
import { LangfuseTraceSource } from "./langfuse-source.js";
import { LangsmithTraceSource } from "./langsmith-source.js";
import { PhoenixTraceSource, phoenixSpansToTraceEvents } from "./phoenix-source.js";

// 순차 응답 fetch 페이크 — 호출 기록 + 준비한 Response 순서 반환(기본 200 {}).
function fakeFetch(responses: Response[] = []) {
  let i = 0;
  const impl = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(responses[i++] ?? new Response("{}", { status: 200 })),
  );
  const call = (n: number): { url: string; init: RequestInit } => {
    const c = impl.mock.calls[n];
    if (!c) throw new Error(`fetch 호출 ${n} 없음`);
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
        usage: { input: 999, output: 999 }, // deprecated — usageDetails 가 우선해야 한다
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
      { type: "SPAN", name: "구조 스팬(스킵)", startTime: "2026-07-06T09:00:02.000Z", level: "DEFAULT" },
    ],
  };

  it("GET /api/public/traces/{id} 의 관측을 정규화한다 — usageDetails 우선, TOOL→tool 쌍, 구조 스팬 스킵", async () => {
    const ff = fakeFetch([new Response(JSON.stringify(DETAIL), { status: 200 })]);
    const src = new LangfuseTraceSource({ endpoint: "https://lf", auth: "Basic cGs6c2s=", fetchImpl: ff.impl });
    const trace = await src.fetch("trace_abc");
    expect(ff.call(0).url).toBe("https://lf/api/public/traces/trace_abc");
    expect((ff.call(0).init.headers as Record<string, string>).authorization).toBe("Basic cGs6c2s=");
    const llm = trace.find((e) => e.kind === "llm_call");
    expect(llm?.kind === "llm_call" && llm.model).toBe("gpt-4o");
    expect(llm?.kind === "llm_call" && llm.cost).toEqual({ inputTokens: 1200, outputTokens: 300, usd: 0.021 });
    expect(llm?.kind === "llm_call" && llm.latencyMs).toBe(3000);
    // TOOL 관측이 가장 이르므로 t=0, tool_call/result 쌍으로.
    expect(trace.filter((e) => e.kind === "tool_call" || e.kind === "tool_result")).toHaveLength(2);
    expect(
      trace.filter((e) => e.kind === "llm_call" || e.kind === "tool_call" || e.kind === "tool_result"),
    ).toHaveLength(3);
  });

  it("404 → [](트레이스 부재 degrade) · 비-2xx → UpstreamError", async () => {
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
  it("POST /runs/query {trace} + x-api-key + cursors.next 루프로 run 전체를 모아 정규화한다", async () => {
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
          total_cost: "0.00342", // 십진 문자열
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
    expect(ff.count()).toBe(2); // 커서 루프 2페이지
    expect(ff.call(0).url).toBe("https://api.smith.langchain.com/runs/query");
    expect((ff.call(0).init.headers as Record<string, string>)["x-api-key"]).toBe("lsv2_x");
    const body1 = JSON.parse(String(ff.call(0).init.body)) as Record<string, unknown>;
    expect(body1.trace).toBe("9c1e1a05-0000-4000-8000-000000000001");
    expect(JSON.parse(String(ff.call(1).init.body)).cursor).toBe("cur-2");
    // llm run: 모델은 ls_model_name 메타, 비용은 십진 문자열 파싱.
    const llm = trace.find((e) => e.kind === "llm_call");
    expect(llm?.kind === "llm_call" && llm.model).toBe("claude-sonnet-4");
    expect(llm?.kind === "llm_call" && llm.cost?.usd).toBeCloseTo(0.00342);
    // tool run → 쌍, chain(구조) run → 스킵.
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
        // 읽기 쪽은 '중첩' 속성 — 평면 dotted 키가 아니어도 파싱돼야 한다.
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

  it("GET /v1/projects/{p}/spans?trace_id= 로 스팬을 가져와 정규화한다(중첩 속성 + ERROR→ok:false)", async () => {
    const ff = fakeFetch([new Response(JSON.stringify(SPANS), { status: 200 })]);
    const src = new PhoenixTraceSource({
      endpoint: "http://phoenix:6006",
      auth: "Bearer px",
      project: "assay",
      fetchImpl: ff.impl,
    });
    const trace = await src.fetch("a".repeat(32));
    expect(ff.call(0).url).toBe(`http://phoenix:6006/v1/projects/assay/spans?trace_id=${"a".repeat(32)}&limit=1000`);
    expect((ff.call(0).init.headers as Record<string, string>).authorization).toBe("Bearer px");
    const llm = trace.find((e) => e.kind === "llm_call");
    expect(llm?.kind === "llm_call" && llm.model).toBe("gpt-4o");
    expect(llm?.kind === "llm_call" && llm.cost?.inputTokens).toBe(1200);
    const result = trace.find((e) => e.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.ok).toBe(false); // status_code ERROR
    expect(result?.kind === "tool_result" && result.output).toBe("exit 1");
  });

  it("project 미설정 → 정직한 UpstreamError(조용한 빈 결과 금지)", async () => {
    const src = new PhoenixTraceSource({ endpoint: "http://px", fetchImpl: fakeFetch().impl });
    await expect(src.fetch("a".repeat(32))).rejects.toBeInstanceOf(AppError);
  });

  it("phoenixSpansToTraceEvents: 평면 dotted 키(쓰기 모양)도 동일하게 정규화한다(양방향 방어)", () => {
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

describe("buildTraceSource — 신형 kind 조립", () => {
  it("langfuse/langsmith/phoenix kind 를 어댑터로 조립하고, headers.authorization 은 auth 값으로 승계한다", async () => {
    expect(buildTraceSource({ kind: "langfuse", endpoint: "http://l" })).toBeInstanceOf(LangfuseTraceSource);
    expect(buildTraceSource({ kind: "langsmith", endpoint: "http://s" })).toBeInstanceOf(LangsmithTraceSource);
    expect(buildTraceSource({ kind: "phoenix", endpoint: "http://p", project: "a" })).toBeInstanceOf(
      PhoenixTraceSource,
    );
    // 기존 pull 경로는 headers.authorization 로만 주입한다 — langsmith 는 이를 x-api-key 로 배치해야 한다.
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
