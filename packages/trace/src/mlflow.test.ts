import { AppError } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { MlflowTraceSource, parseMlflowTrace } from "./mlflow.js";

// 실제 MLflow 3.11.1 `GET /api/3.0/mlflow/traces/get` 응답에서 캡처한 스팬 모양(OTLP AnyValue, snake_case).
// 어댑터를 실제 MLflow 스키마에 고정한다 — 라이브 인프라 없이도 CI 가 드리프트를 잡도록.
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
  it("snake_case AnyValue 배열을 평탄화한다(string/bool/중첩 kvlist)", () => {
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
  it("실제 응답 모양 → llm_call(model) + tool_call(bash) 로 정규화", async () => {
    const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify(REAL_TRACE), { status: 200 })),
    );
    const src = new MlflowTraceSource({ endpoint: "http://mlflow:5000", fetchImpl: fetchImpl as typeof fetch });
    const ev = await src.fetch("tr-abc");
    expect(ev.find((e) => e.kind === "llm_call")).toMatchObject({ model: "gpt-5.4-mini" });
    expect(ev.find((e) => e.kind === "tool_call")).toMatchObject({ name: "bash" });
    // V3 엔드포인트 경로 확인
    expect(fetchImpl.mock.calls[0]?.[0] as string).toMatch(/\/api\/3\.0\/mlflow\/traces\/get\?trace_id=tr-abc$/);
  });

  it("404(트레이스 없음) → [] degrade(서비스 하니스 경로)", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("not found", { status: 404 })));
    const src = new MlflowTraceSource({ endpoint: "http://m", fetchImpl: fetchImpl as typeof fetch });
    expect(await src.fetch("missing")).toEqual([]);
  });

  it("401/5xx 등 non-2xx(404 외) → UpstreamError", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("denied", { status: 401 })));
    const src = new MlflowTraceSource({ endpoint: "http://m", fetchImpl: fetchImpl as typeof fetch });
    await expect(src.fetch("t")).rejects.toBeInstanceOf(AppError);
  });
});

// correlate="tag" — 계측 에이전트가 자기 trace 에 남긴 everdict.run_id 태그로 검색(실 MLflow 3.14 API 형태 고정).
describe("MlflowTraceSource — tag 상관", () => {
  it("traces/search(locations+tags.`everdict.run_id` 필터)로 trace_id 를 찾은 뒤 그 id 로 스팬을 가져온다", async () => {
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
    // 실 3.14 검증 형태: locations 필수 + 백틱 태그 필터.
    expect(search.locations).toEqual([{ type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: "7" } }]);
    expect(search.filter).toBe("tags.`everdict.run_id` = 'everdict-run-1'");
    expect(calls[1]?.url).toContain("trace_id=tr-found");
    expect(events.some((e) => e.kind === "llm_call")).toBe(true);
  });

  it("태그 미발견 → [] degrade(id 모드의 404 와 동일), experiment 미지정 → 명시 에러(locations 필수)", async () => {
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
