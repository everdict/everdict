import { AppError, type TraceEvent } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { buildTraceSink } from "./build-sink.js";
import { LangfuseTraceSink, chunkLangfuseEvents, langfuseBatch } from "./langfuse-sink.js";
import { LangsmithTraceSink } from "./langsmith-sink.js";
import { MlflowTraceSink, mlflowAssessmentBody } from "./mlflow-sink.js";
import { PhoenixTraceSink, phoenixAnnotation, phoenixSpans } from "./phoenix-sink.js";
import type { TraceSinkCase, TraceSinkContext } from "./trace-sink.js";

const CTX: TraceSinkContext = { scorecardId: "sc-1", dataset: "d@1.0.0", harness: "h@1" };
const TRACE: TraceEvent[] = [
  { t: 0, kind: "message", role: "user", text: "task 지시" },
  { t: 10, kind: "llm_call", model: "gpt-x", cost: { inputTokens: 100, outputTokens: 50, usd: 0.02 }, latencyMs: 5 },
  { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
  { t: 30, kind: "tool_result", id: "t1", ok: true, output: "done" },
  { t: 40, kind: "message", role: "assistant", text: "완료" },
];
const CASE: TraceSinkCase = {
  caseId: "c1",
  trace: TRACE,
  scores: [
    { name: "tests_pass", value: 1, pass: true },
    { name: "judge:quality", value: 0.8, comment: "근거 충분" },
  ],
};

// 순차 응답 fetch 페이크 — 호출 기록 + 미리 준비한 Response 를 순서대로 반환(기본 200 {}).
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
  const body = (n: number): Record<string, unknown> => JSON.parse(String(call(n).init.body)) as Record<string, unknown>;
  return { impl: impl as unknown as typeof fetch, call, body, count: () => impl.mock.calls.length };
}

const seq = (prefix: string) => {
  let n = 0;
  return () => `${prefix}0000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

describe("MlflowTraceSink", () => {
  it("create 모드: StartTraceV3(trace_info)로 trace 를 만들고 assessments 로 점수를 부착한다(assessment_name/source 필수)", async () => {
    const ff = fakeFetch();
    const sink = new MlflowTraceSink({
      endpoint: "http://mlflow:5000",
      auth: "Basic c2s=",
      project: "7",
      fetchImpl: ff.impl,
      newId: seq("aaaa"),
      now: () => "2026-07-06T00:00:00.000Z",
    });
    const out = await sink.export(CTX, [CASE]);
    // trace 생성 1콜 + OTLP 스팬 1콜 + 점수 2콜.
    expect(ff.count()).toBe(4);
    expect(ff.call(0).url).toBe("http://mlflow:5000/api/3.0/mlflow/traces");
    const info = (ff.body(0).trace as { trace_info: Record<string, unknown> }).trace_info;
    expect(info.trace_id).toMatch(/^tr-[0-9a-f]{32}$/);
    expect(info.trace_location).toEqual({ type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: "7" } });
    expect(info.request_preview).toBe("task 지시");
    // 스팬: OTLP/JSON — x-mlflow-experiment-id 헤더 + TraceInfo 와 같은 hex(tr- 접두 제거)로 조인.
    expect(ff.call(1).url).toBe("http://mlflow:5000/v1/traces");
    expect((ff.call(1).init.headers as Record<string, string>)["x-mlflow-experiment-id"]).toBe("7");
    const rs = ff.body(1).resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    const spans = rs[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans[0]?.traceId).toBe(String(info.trace_id).slice(3));
    // 자식 스팬 속성은 우리 소스가 읽는 OTel GenAI 관례 → pull 되읽기 왕복 정합.
    const llmAttrs = spans[1]?.attributes as Array<{ key: string; value: Record<string, unknown> }>;
    expect(llmAttrs.find((a) => a.key === "gen_ai.request.model")?.value).toEqual({ stringValue: "gpt-x" });
    expect(llmAttrs.find((a) => a.key === "gen_ai.usage.input_tokens")?.value).toEqual({ intValue: "100" });
    // 점수: snake_case + assessment_name + source_type 분류(CODE/LLM_JUDGE) + rationale.
    expect(ff.call(2).url).toMatch(/\/api\/3\.0\/mlflow\/traces\/tr-[0-9a-f]{32}\/assessments$/);
    const a1 = ff.body(2).assessment as Record<string, unknown>;
    expect(a1.assessment_name).toBe("tests_pass");
    expect(a1.source).toEqual({ source_type: "CODE", source_id: "everdict:sc-1" });
    const a2 = ff.body(3).assessment as Record<string, unknown>;
    expect(a2.source).toEqual({ source_type: "LLM_JUDGE", source_id: "everdict:sc-1" });
    expect(a2.rationale).toBe("근거 충분");
    // 인증 헤더는 값 그대로(Basic …) + 케이스 결과에 외부 id/딥링크.
    expect((ff.call(0).init.headers as Record<string, string>).authorization).toBe("Basic c2s=");
    expect(out.cases[0]?.externalId).toMatch(/^tr-/);
    expect(out.cases[0]?.url).toContain("/#/experiments/7/traces?selectedEvaluationId=tr-");
    expect(out.url).toBe("http://mlflow:5000/#/experiments/7/traces");
  });

  it("attach 모드(externalId): trace 생성/스팬 업로드 없이 기존 trace 에 점수만 부착한다(흐름② — 복제 금지)", async () => {
    const ff = fakeFetch();
    const sink = new MlflowTraceSink({ endpoint: "http://mlflow:5000", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [{ ...CASE, externalId: "tr-orig" }]);
    expect(ff.count()).toBe(2); // 점수 2콜만 — StartTraceV3/OTLP 없음
    expect(ff.call(0).url).toContain("/traces/tr-orig/assessments");
    expect(out.cases[0]?.externalId).toBe("tr-orig");
  });

  it("스팬 업로드(OTLP)가 실패해도 케이스는 성공 — best-effort(구버전 서버 degrade)", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 200 }), // trace 생성
      new Response("unsupported", { status: 415 }), // 스팬 업로드 실패(protobuf 전용 서버)
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
    ]);
    const sink = new MlflowTraceSink({ endpoint: "http://m", project: "7", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(out.cases[0]?.error).toBeUndefined();
    expect(out.cases[0]?.externalId).toMatch(/^tr-/);
  });

  it("create 모드에서 project(experiment_id) 미설정 → 케이스별 정직한 실패(조용한 스킵 금지)", async () => {
    const ff = fakeFetch();
    const sink = new MlflowTraceSink({ endpoint: "http://mlflow:5000", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(ff.count()).toBe(0);
    expect(out.cases[0]?.error).toContain("project(experiment_id)");
  });

  it("assessment 비-2xx → 그 케이스만 실패로 격리(다른 케이스는 계속)", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 200 }), // c1 trace 생성
      new Response("{}", { status: 200 }), // c1 스팬
      new Response("boom", { status: 500 }), // c1 첫 점수 실패
      new Response("{}", { status: 200 }), // c2 trace 생성
      new Response("{}", { status: 200 }), // c2 스팬
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
    ]);
    const sink = new MlflowTraceSink({ endpoint: "http://m", project: "7", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE, { ...CASE, caseId: "c2" }]);
    expect(out.cases[0]?.error).toContain("500");
    expect(out.cases[1]?.error).toBeUndefined();
  });
});

describe("LangfuseTraceSink", () => {
  it("create 모드: 배치 ingestion 1콜 — trace-create + generation-create(usageDetails/costDetails) + score-create", async () => {
    const ff = fakeFetch([new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 })]);
    const sink = new LangfuseTraceSink({
      endpoint: "https://langfuse.corp.io",
      auth: "Basic cGs6c2s=",
      project: "proj-1",
      fetchImpl: ff.impl,
      newId: seq("bbbb"),
      now: () => "2026-07-06T00:00:00.000Z",
    });
    const out = await sink.export(CTX, [CASE]);
    expect(ff.count()).toBe(1);
    expect(ff.call(0).url).toBe("https://langfuse.corp.io/api/public/ingestion");
    expect((ff.call(0).init.headers as Record<string, string>).authorization).toBe("Basic cGs6c2s=");
    const batch = ff.body(0).batch as Array<{ type: string; body: Record<string, unknown> }>;
    const types = batch.map((e) => e.type);
    expect(types).toContain("trace-create");
    expect(types).toContain("generation-create");
    expect(types).toContain("span-create"); // tool_call → span
    expect(types.filter((t) => t === "score-create")).toHaveLength(2);
    const gen = batch.find((e) => e.type === "generation-create")?.body as Record<string, unknown>;
    expect(gen.usageDetails).toEqual({ input: 100, output: 50 }); // usage(구식) 아닌 usageDetails
    expect(gen.costDetails).toEqual({ total: 0.02 });
    // 케이스 결과: 생성한 traceId + 프로젝트 딥링크.
    expect(out.cases[0]?.externalId).toBeTruthy();
    expect(out.cases[0]?.url).toContain("/project/proj-1/traces/");
  });

  it("attach 모드: score-create 만 — 기존 traceId 로 점수 부착 + project 미설정이면 /trace/{id} 리다이렉트 링크", async () => {
    const ff = fakeFetch([new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 })]);
    const sink = new LangfuseTraceSink({ endpoint: "https://lf", fetchImpl: ff.impl, newId: seq("cccc") });
    const out = await sink.export(CTX, [{ ...CASE, externalId: "lf-trace-9" }]);
    const batch = ff.body(0).batch as Array<{ type: string; body: Record<string, unknown> }>;
    expect(batch.every((e) => e.type === "score-create")).toBe(true);
    expect(batch[0]?.body.traceId).toBe("lf-trace-9");
    expect(out.cases[0]?.url).toBe("https://lf/trace/lf-trace-9");
  });

  it("207 errors[] 의 이벤트 id 를 케이스로 역매핑해 부분 실패를 격리한다", async () => {
    // langfuseBatch 로 미리 이벤트 id 를 뽑아 첫 케이스의 이벤트 하나를 실패시킨다.
    const newId = seq("dddd");
    const pre = langfuseBatch(CTX, [CASE, { ...CASE, caseId: "c2" }], newId, () => "2026-07-06T00:00:00.000Z");
    const failId = [...pre.eventCase.entries()].find(([, cid]) => cid === "c1")?.[0];
    const ff = fakeFetch([
      new Response(JSON.stringify({ successes: [], errors: [{ id: failId, message: "invalid" }] }), { status: 207 }),
    ]);
    const sink = new LangfuseTraceSink({
      endpoint: "https://lf",
      fetchImpl: ff.impl,
      newId: seq("dddd"), // 같은 시퀀스 → 같은 이벤트 id
      now: () => "2026-07-06T00:00:00.000Z",
    });
    const out = await sink.export(CTX, [CASE, { ...CASE, caseId: "c2" }]);
    expect(out.cases[0]?.error).toBe("invalid");
    expect(out.cases[1]?.error).toBeUndefined();
  });

  it("배치 전면 실패(401 등 비-2xx/207) → UpstreamError(AppError)", async () => {
    const ff = fakeFetch([new Response("unauthorized", { status: 401 })]);
    const sink = new LangfuseTraceSink({ endpoint: "https://lf", fetchImpl: ff.impl });
    await expect(sink.export(CTX, [CASE])).rejects.toBeInstanceOf(AppError);
  });

  it("3.5MB 상한: 직렬화 크기 기준으로 청크 분할 — 여러 ingestion 콜, 순서 보존, 조용한 드랍 없음", async () => {
    // 이벤트 2개가 한 청크(약 1KB 상한)에 안 들어가게 만들어 분할을 강제한다.
    const big = "x".repeat(700);
    const events = [
      { id: "e1", body: big },
      { id: "e2", body: big },
      { id: "e3", body: big },
    ];
    const chunks = chunkLangfuseEvents(events, 1500);
    expect(chunks.map((c) => c.length)).toEqual([2, 1]); // 2+1 로 분할(700*2+α < 1500 < 700*3)
    expect(chunks.flat().map((e) => e.id)).toEqual(["e1", "e2", "e3"]); // 순서/전수 보존

    // 실제 export 경로에서도 분할된 만큼 콜이 나간다.
    const ff = fakeFetch([
      new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 }),
      new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 }),
    ]);
    const sink = new LangfuseTraceSink({ endpoint: "https://lf", fetchImpl: ff.impl, newId: seq("aaaa") });
    // 케이스 2개(각각 trace+관측+점수 이벤트) — 기본 3MB 상한에선 1콜이어야 한다(회귀 확인).
    await sink.export(CTX, [CASE, { ...CASE, caseId: "c2" }]);
    expect(ff.count()).toBe(1);
  });
});

describe("LangsmithTraceSink", () => {
  it("create 모드: 케이스당 POST /runs(클라이언트 uuid·원샷 outputs·session_name) + 점수당 POST /feedback(x-api-key)", async () => {
    const ff = fakeFetch();
    const sink = new LangsmithTraceSink({
      endpoint: "https://api.smith.langchain.com",
      auth: "lsv2_key",
      project: "everdict-evals",
      fetchImpl: ff.impl,
      newId: seq("eeee"),
      now: () => "2026-07-06T00:00:00.000Z",
    });
    const out = await sink.export(CTX, [CASE]);
    expect(ff.count()).toBe(4); // run 1 + feedback 2 + app_path 조회 1
    expect(ff.call(0).url).toBe("https://api.smith.langchain.com/runs");
    expect((ff.call(0).init.headers as Record<string, string>)["x-api-key"]).toBe("lsv2_key"); // Authorization 아님
    const run = ff.body(0);
    expect(run.id).toBe(run.trace_id); // 루트 run: trace_id = 자기 id
    expect(run.run_type).toBe("chain");
    expect(run.session_name).toBe("everdict-evals");
    expect((run.outputs as Record<string, unknown>).output).toBe("완료");
    const fb = ff.body(1);
    expect(fb.key).toBe("tests_pass");
    expect((fb.feedback_source as Record<string, unknown>).type).toBe("api");
    expect((ff.body(2).feedback_source as Record<string, unknown>).type).toBe("model"); // judge:* → model
    expect(out.cases[0]?.externalId).toBe(run.id);
  });

  it("run 접수(202) 직후 feedback 404 → 1회 재시도 후 성공(비동기 접수 보정)", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 202 }), // run
      new Response("not found", { status: 404 }), // 첫 feedback — 아직 미접수
      new Response("{}", { status: 200 }), // 재시도 성공
      new Response("{}", { status: 200 }), // 두 번째 점수
      new Response("{}", { status: 200 }), // app_path 조회(빈 응답 → 링크 생략)
    ]);
    const sink = new LangsmithTraceSink({ endpoint: "https://ls", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(ff.count()).toBe(5);
    expect(out.cases[0]?.error).toBeUndefined();
    expect(out.cases[0]?.url).toBeUndefined(); // app_path 없으면 링크 생략(best-effort)
  });

  it("케이스 딥링크: GET /runs/{id} 의 app_path 를 웹 베이스에 조인한다(uuid 직접 조립 금지)", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 202 }), // run
      new Response("{}", { status: 200 }), // feedback 1
      new Response("{}", { status: 200 }), // feedback 2
      new Response(JSON.stringify({ app_path: "/o/t-1/projects/p/p-1/r/r-1" }), { status: 200 }),
    ]);
    const sink = new LangsmithTraceSink({
      endpoint: "https://ls",
      webUrl: "https://smith.corp.io",
      fetchImpl: ff.impl,
    });
    const out = await sink.export(CTX, [CASE]);
    expect(out.cases[0]?.url).toBe("https://smith.corp.io/o/t-1/projects/p/p-1/r/r-1");
  });
});

describe("PhoenixTraceSink", () => {
  it("create 모드: JSON 스팬(POST /v1/projects/{p}/spans — OTLP JSON 아님) + trace_annotations 로 점수 부착", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 202 }),
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ]);
    const sink = new PhoenixTraceSink({
      endpoint: "http://phoenix:6006",
      auth: "Bearer px-key",
      project: "everdict",
      fetchImpl: ff.impl,
      newId: seq("ffff"),
      now: () => "2026-07-06T00:00:00.000Z",
    });
    const out = await sink.export(CTX, [CASE]);
    expect(ff.call(0).url).toBe("http://phoenix:6006/v1/projects/everdict/spans");
    const spans = ff.body(0).data as Array<Record<string, unknown>>;
    // 루트 CHAIN + LLM + TOOL 스팬, id 는 OTel hex(trace 32/span 16).
    expect(spans.map((s) => s.span_kind)).toEqual(["CHAIN", "LLM", "TOOL"]);
    const rootCtx = spans[0]?.context as { trace_id: string; span_id: string };
    expect(rootCtx.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(rootCtx.span_id).toMatch(/^[0-9a-f]{16}$/);
    const llm = spans[1]?.attributes as Record<string, unknown>;
    expect(llm["llm.model_name"]).toBe("gpt-x");
    expect(llm["llm.token_count.prompt"]).toBe(100);
    // annotations: trace_id 기준 + judge 분류 + redirects 딥링크.
    expect(ff.call(1).url).toBe("http://phoenix:6006/v1/trace_annotations");
    const anns = ff.body(1).data as Array<Record<string, unknown>>;
    expect(anns[0]?.annotator_kind).toBe("CODE");
    expect(anns[1]?.annotator_kind).toBe("LLM");
    expect(out.cases[0]?.url).toContain("/redirects/traces/");
  });

  it("create 모드에서 project 미설정 → 케이스별 정직한 실패", async () => {
    const ff = fakeFetch();
    const sink = new PhoenixTraceSink({ endpoint: "http://px", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(out.cases[0]?.error).toContain("project");
  });

  it("attach 모드: 스팬 생성 없이 기존 OTel trace id 에 annotation 만 부착한다", async () => {
    const ff = fakeFetch([new Response(JSON.stringify({ data: [] }), { status: 200 })]);
    const sink = new PhoenixTraceSink({ endpoint: "http://px", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [{ ...CASE, externalId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }]);
    expect(ff.count()).toBe(1);
    expect(ff.call(0).url).toContain("/v1/trace_annotations");
    expect(out.cases[0]?.externalId).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
  });
});

describe("buildTraceSink · 순수 빌더", () => {
  it("kind 별로 올바른 어댑터를 조립한다(설정→어댑터 대칭, buildTraceSource 와 동일 패턴)", () => {
    expect(buildTraceSink({ kind: "mlflow", endpoint: "http://m" })).toBeInstanceOf(MlflowTraceSink);
    expect(buildTraceSink({ kind: "langfuse", endpoint: "http://l" })).toBeInstanceOf(LangfuseTraceSink);
    expect(buildTraceSink({ kind: "langsmith", endpoint: "http://s" })).toBeInstanceOf(LangsmithTraceSink);
    expect(buildTraceSink({ kind: "phoenix", endpoint: "http://p" })).toBeInstanceOf(PhoenixTraceSink);
  });

  it("mlflowAssessmentBody: pass 는 문자열 metadata 로(맵 값은 string 만), 값은 feedback.value 로", () => {
    const body = mlflowAssessmentBody({ name: "tests_pass", value: 1, pass: true }, "everdict:sc-1");
    const a = body.assessment as Record<string, unknown>;
    expect(a.feedback).toEqual({ value: 1 });
    expect(a.metadata).toEqual({ pass: "true" });
  });

  it("phoenixSpans/phoenixAnnotation: 상대 t(ms)를 절대 ISO 로, pass → label(pass/fail)로 변환한다", () => {
    const spans = phoenixSpans(CTX, CASE, "a".repeat(32), "2026-07-06T00:00:01.000Z", seq("abcd"));
    expect(String(spans[0]?.start_time)).toBe("2026-07-06T00:00:00.960Z"); // now - maxT(40ms)
    const ann = phoenixAnnotation("a".repeat(32), { name: "tests_pass", value: 0, pass: false });
    expect((ann.result as Record<string, unknown>).label).toBe("fail");
  });
});
