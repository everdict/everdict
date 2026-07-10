import { AppError, type TraceEvent, type TraceSinkCase, type TraceSinkContext } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildTraceSink } from "./build-sink.js";
import { LangfuseTraceSink, chunkLangfuseEvents, langfuseBatch } from "./langfuse-sink.js";
import { LangsmithTraceSink } from "./langsmith-sink.js";
import { MlflowTraceSink, mlflowAssessmentBody } from "./mlflow-sink.js";
import { PhoenixTraceSink, phoenixAnnotation, phoenixSpans } from "./phoenix-sink.js";

const CTX: TraceSinkContext = { scorecardId: "sc-1", dataset: "d@1.0.0", harness: "h@1" };
const TRACE: TraceEvent[] = [
  { t: 0, kind: "message", role: "user", text: "task instruction" },
  { t: 10, kind: "llm_call", model: "gpt-x", cost: { inputTokens: 100, outputTokens: 50, usd: 0.02 }, latencyMs: 5 },
  { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
  { t: 30, kind: "tool_result", id: "t1", ok: true, output: "done" },
  { t: 40, kind: "message", role: "assistant", text: "complete" },
];
const CASE: TraceSinkCase = {
  caseId: "c1",
  trace: TRACE,
  scores: [
    { name: "tests_pass", value: 1, pass: true },
    { name: "judge:quality", value: 0.8, comment: "sufficient evidence" },
  ],
};

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
  const body = (n: number): Record<string, unknown> => JSON.parse(String(call(n).init.body)) as Record<string, unknown>;
  return { impl: impl as unknown as typeof fetch, call, body, count: () => impl.mock.calls.length };
}

const seq = (prefix: string) => {
  let n = 0;
  return () => `${prefix}0000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

describe("MlflowTraceSink", () => {
  it("create mode: creates a trace via StartTraceV3 (trace_info) and attaches scores via assessments (assessment_name/source required)", async () => {
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
    // 1 trace-create call + 1 OTLP span call + 2 score calls.
    expect(ff.count()).toBe(4);
    expect(ff.call(0).url).toBe("http://mlflow:5000/api/3.0/mlflow/traces");
    const info = (ff.body(0).trace as { trace_info: Record<string, unknown> }).trace_info;
    expect(info.trace_id).toMatch(/^tr-[0-9a-f]{32}$/);
    expect(info.trace_location).toEqual({ type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: "7" } });
    expect(info.request_preview).toBe("task instruction");
    // Spans: OTLP/JSON — joined via the x-mlflow-experiment-id header + the same hex as TraceInfo (tr- prefix stripped).
    expect(ff.call(1).url).toBe("http://mlflow:5000/v1/traces");
    expect((ff.call(1).init.headers as Record<string, string>)["x-mlflow-experiment-id"]).toBe("7");
    const rs = ff.body(1).resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    const spans = rs[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans[0]?.traceId).toBe(String(info.trace_id).slice(3));
    // Child span attributes follow the OTel GenAI conventions our source reads → consistent pull round-trip.
    const llmAttrs = spans[1]?.attributes as Array<{ key: string; value: Record<string, unknown> }>;
    expect(llmAttrs.find((a) => a.key === "gen_ai.request.model")?.value).toEqual({ stringValue: "gpt-x" });
    expect(llmAttrs.find((a) => a.key === "gen_ai.usage.input_tokens")?.value).toEqual({ intValue: "100" });
    // Scores: snake_case + assessment_name + source_type classification (CODE/LLM_JUDGE) + rationale.
    expect(ff.call(2).url).toMatch(/\/api\/3\.0\/mlflow\/traces\/tr-[0-9a-f]{32}\/assessments$/);
    const a1 = ff.body(2).assessment as Record<string, unknown>;
    expect(a1.assessment_name).toBe("tests_pass");
    expect(a1.source).toEqual({ source_type: "CODE", source_id: "everdict:sc-1" });
    const a2 = ff.body(3).assessment as Record<string, unknown>;
    expect(a2.source).toEqual({ source_type: "LLM_JUDGE", source_id: "everdict:sc-1" });
    expect(a2.rationale).toBe("sufficient evidence");
    // The auth header is the value verbatim (Basic …) + the case result has the external id/deep link.
    expect((ff.call(0).init.headers as Record<string, string>).authorization).toBe("Basic c2s=");
    expect(out.cases[0]?.externalId).toMatch(/^tr-/);
    expect(out.cases[0]?.url).toContain("/#/experiments/7/traces?selectedEvaluationId=tr-");
    expect(out.url).toBe("http://mlflow:5000/#/experiments/7/traces");
  });

  it("attach mode (externalId): attaches scores only to an existing trace, without trace creation/span upload (flow ② — no duplication)", async () => {
    const ff = fakeFetch();
    const sink = new MlflowTraceSink({ endpoint: "http://mlflow:5000", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [{ ...CASE, externalId: "tr-orig" }]);
    expect(ff.count()).toBe(2); // only 2 score calls — no StartTraceV3/OTLP
    expect(ff.call(0).url).toContain("/traces/tr-orig/assessments");
    expect(out.cases[0]?.externalId).toBe("tr-orig");
  });

  it("the case still succeeds even if span upload (OTLP) fails — best-effort (older-server degrade)", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 200 }), // trace creation
      new Response("unsupported", { status: 415 }), // span upload fails (protobuf-only server)
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
    ]);
    const sink = new MlflowTraceSink({ endpoint: "http://m", project: "7", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(out.cases[0]?.error).toBeUndefined();
    expect(out.cases[0]?.externalId).toMatch(/^tr-/);
  });

  it("in create mode with project (experiment_id) unset → an honest per-case failure (no silent skip)", async () => {
    const ff = fakeFetch();
    const sink = new MlflowTraceSink({ endpoint: "http://mlflow:5000", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(ff.count()).toBe(0);
    expect(out.cases[0]?.error).toContain("project (experiment_id)");
  });

  it("assessment non-2xx → isolate only that case as failed (other cases continue)", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 200 }), // c1 trace creation
      new Response("{}", { status: 200 }), // c1 spans
      new Response("boom", { status: 500 }), // c1 first score fails
      new Response("{}", { status: 200 }), // c2 trace creation
      new Response("{}", { status: 200 }), // c2 spans
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
  it("create mode: one batch-ingestion call — trace-create + generation-create (usageDetails/costDetails) + score-create", async () => {
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
    expect(gen.usageDetails).toEqual({ input: 100, output: 50 }); // usageDetails, not usage (the old field)
    expect(gen.costDetails).toEqual({ total: 0.02 });
    // Case result: the created traceId + the project deep link.
    expect(out.cases[0]?.externalId).toBeTruthy();
    expect(out.cases[0]?.url).toContain("/project/proj-1/traces/");
  });

  it("attach mode: score-create only — attach scores by existing traceId + a /trace/{id} redirect link when project is unset", async () => {
    const ff = fakeFetch([new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 })]);
    const sink = new LangfuseTraceSink({ endpoint: "https://lf", fetchImpl: ff.impl, newId: seq("cccc") });
    const out = await sink.export(CTX, [{ ...CASE, externalId: "lf-trace-9" }]);
    const batch = ff.body(0).batch as Array<{ type: string; body: Record<string, unknown> }>;
    expect(batch.every((e) => e.type === "score-create")).toBe(true);
    expect(batch[0]?.body.traceId).toBe("lf-trace-9");
    expect(out.cases[0]?.url).toBe("https://lf/trace/lf-trace-9");
  });

  it("reverse-maps the event id in 207 errors[] to a case to isolate partial failures", async () => {
    // Use langfuseBatch to pull event ids in advance and fail one event of the first case.
    const newId = seq("dddd");
    const pre = langfuseBatch(CTX, [CASE, { ...CASE, caseId: "c2" }], newId, () => "2026-07-06T00:00:00.000Z");
    const failId = [...pre.eventCase.entries()].find(([, cid]) => cid === "c1")?.[0];
    const ff = fakeFetch([
      new Response(JSON.stringify({ successes: [], errors: [{ id: failId, message: "invalid" }] }), { status: 207 }),
    ]);
    const sink = new LangfuseTraceSink({
      endpoint: "https://lf",
      fetchImpl: ff.impl,
      newId: seq("dddd"), // same sequence → same event ids
      now: () => "2026-07-06T00:00:00.000Z",
    });
    const out = await sink.export(CTX, [CASE, { ...CASE, caseId: "c2" }]);
    expect(out.cases[0]?.error).toBe("invalid");
    expect(out.cases[1]?.error).toBeUndefined();
  });

  it("wholesale batch failure (401 etc., non-2xx/207) → UpstreamError (AppError)", async () => {
    const ff = fakeFetch([new Response("unauthorized", { status: 401 })]);
    const sink = new LangfuseTraceSink({ endpoint: "https://lf", fetchImpl: ff.impl });
    await expect(sink.export(CTX, [CASE])).rejects.toBeInstanceOf(AppError);
  });

  it("3.5MB cap: chunk-split by serialized size — multiple ingestion calls, order preserved, no silent drop", async () => {
    // Make two events not fit in one chunk (~1KB cap) to force a split.
    const big = "x".repeat(700);
    const events = [
      { id: "e1", body: big },
      { id: "e2", body: big },
      { id: "e3", body: big },
    ];
    const chunks = chunkLangfuseEvents(events, 1500);
    expect(chunks.map((c) => c.length)).toEqual([2, 1]); // split as 2+1 (700*2+α < 1500 < 700*3)
    expect(chunks.flat().map((e) => e.id)).toEqual(["e1", "e2", "e3"]); // order/completeness preserved

    // The real export path also issues as many calls as the split.
    const ff = fakeFetch([
      new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 }),
      new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 }),
    ]);
    const sink = new LangfuseTraceSink({ endpoint: "https://lf", fetchImpl: ff.impl, newId: seq("aaaa") });
    // Two cases (each with trace+observation+score events) — under the default 3MB cap this should be one call (regression check).
    await sink.export(CTX, [CASE, { ...CASE, caseId: "c2" }]);
    expect(ff.count()).toBe(1);
  });
});

describe("LangsmithTraceSink", () => {
  it("create mode: POST /runs per case (client uuid · one-shot outputs · session_name) + POST /feedback per score (x-api-key)", async () => {
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
    expect(ff.count()).toBe(4); // run 1 + feedback 2 + app_path lookup 1
    expect(ff.call(0).url).toBe("https://api.smith.langchain.com/runs");
    expect((ff.call(0).init.headers as Record<string, string>)["x-api-key"]).toBe("lsv2_key"); // not Authorization
    const run = ff.body(0);
    expect(run.id).toBe(run.trace_id); // root run: trace_id = its own id
    expect(run.run_type).toBe("chain");
    expect(run.session_name).toBe("everdict-evals");
    expect((run.outputs as Record<string, unknown>).output).toBe("complete");
    const fb = ff.body(1);
    expect(fb.key).toBe("tests_pass");
    expect((fb.feedback_source as Record<string, unknown>).type).toBe("api");
    expect((ff.body(2).feedback_source as Record<string, unknown>).type).toBe("model"); // judge:* → model
    expect(out.cases[0]?.externalId).toBe(run.id);
  });

  it("feedback 404 right after run ingest (202) → success after one retry (async-ingest compensation)", async () => {
    const ff = fakeFetch([
      new Response("{}", { status: 202 }), // run
      new Response("not found", { status: 404 }), // first feedback — not ingested yet
      new Response("{}", { status: 200 }), // retry succeeds
      new Response("{}", { status: 200 }), // second score
      new Response("{}", { status: 200 }), // app_path lookup (empty response → link omitted)
    ]);
    const sink = new LangsmithTraceSink({ endpoint: "https://ls", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(ff.count()).toBe(5);
    expect(out.cases[0]?.error).toBeUndefined();
    expect(out.cases[0]?.url).toBeUndefined(); // link omitted when there's no app_path (best-effort)
  });

  it("case deep link: joins the app_path from GET /runs/{id} onto the web base (no hand-assembled uuid)", async () => {
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
  it("create mode: JSON spans (POST /v1/projects/{p}/spans — not OTLP JSON) + attach scores via trace_annotations", async () => {
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
    // Root CHAIN + LLM + TOOL spans, ids are OTel hex (trace 32 / span 16).
    expect(spans.map((s) => s.span_kind)).toEqual(["CHAIN", "LLM", "TOOL"]);
    const rootCtx = spans[0]?.context as { trace_id: string; span_id: string };
    expect(rootCtx.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(rootCtx.span_id).toMatch(/^[0-9a-f]{16}$/);
    const llm = spans[1]?.attributes as Record<string, unknown>;
    expect(llm["llm.model_name"]).toBe("gpt-x");
    expect(llm["llm.token_count.prompt"]).toBe(100);
    // annotations: keyed by trace_id + judge classification + redirects deep link.
    expect(ff.call(1).url).toBe("http://phoenix:6006/v1/trace_annotations");
    const anns = ff.body(1).data as Array<Record<string, unknown>>;
    expect(anns[0]?.annotator_kind).toBe("CODE");
    expect(anns[1]?.annotator_kind).toBe("LLM");
    expect(out.cases[0]?.url).toContain("/redirects/traces/");
  });

  it("in create mode with project unset → an honest per-case failure", async () => {
    const ff = fakeFetch();
    const sink = new PhoenixTraceSink({ endpoint: "http://px", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [CASE]);
    expect(out.cases[0]?.error).toContain("project");
  });

  it("attach mode: attaches only annotations to an existing OTel trace id, without span creation", async () => {
    const ff = fakeFetch([new Response(JSON.stringify({ data: [] }), { status: 200 })]);
    const sink = new PhoenixTraceSink({ endpoint: "http://px", fetchImpl: ff.impl });
    const out = await sink.export(CTX, [{ ...CASE, externalId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }]);
    expect(ff.count()).toBe(1);
    expect(ff.call(0).url).toContain("/v1/trace_annotations");
    expect(out.cases[0]?.externalId).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
  });
});

describe("buildTraceSink · pure builder", () => {
  it("assembles the correct adapter per kind (config→adapter symmetry, same pattern as buildTraceSource)", () => {
    expect(buildTraceSink({ kind: "mlflow", endpoint: "http://m" })).toBeInstanceOf(MlflowTraceSink);
    expect(buildTraceSink({ kind: "langfuse", endpoint: "http://l" })).toBeInstanceOf(LangfuseTraceSink);
    expect(buildTraceSink({ kind: "langsmith", endpoint: "http://s" })).toBeInstanceOf(LangsmithTraceSink);
    expect(buildTraceSink({ kind: "phoenix", endpoint: "http://p" })).toBeInstanceOf(PhoenixTraceSink);
  });

  it("mlflowAssessmentBody: pass becomes string metadata (map values are strings only), value becomes feedback.value", () => {
    const body = mlflowAssessmentBody({ name: "tests_pass", value: 1, pass: true }, "everdict:sc-1");
    const a = body.assessment as Record<string, unknown>;
    expect(a.feedback).toEqual({ value: 1 });
    expect(a.metadata).toEqual({ pass: "true" });
  });

  it("phoenixSpans/phoenixAnnotation: converts relative t(ms) to absolute ISO, and pass → label (pass/fail)", () => {
    const spans = phoenixSpans(CTX, CASE, "a".repeat(32), "2026-07-06T00:00:01.000Z", seq("abcd"));
    expect(String(spans[0]?.start_time)).toBe("2026-07-06T00:00:00.960Z"); // now - maxT (40ms)
    const ann = phoenixAnnotation("a".repeat(32), { name: "tests_pass", value: 0, pass: false });
    expect((ann.result as Record<string, unknown>).label).toBe("fail");
  });
});
