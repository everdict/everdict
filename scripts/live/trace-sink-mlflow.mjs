// live: trace sink export to real MLflow 3.x — verifies the two modes in docs/architecture/trace-sink.md.
//   create (flow ①): MlflowTraceSink creates a trace via StartTraceV3 and attaches scores as assessments
//     (+ OTLP/JSON spans only on servers ≥3.12 — below that, observe the degrade with spans simply missing).
//   attach (flow ②): attach scores only onto an existing trace id (no duplication) → assessments grow.
//   round-trip: read back with MlflowTraceSource.fetch (if spans were uploaded, normalize into TraceEvents).
//
// Setup: MLflow 3.x (Basic auth) — the infra stack (:5501) or any server. Env: MLFLOW_ENDPOINT, MLFLOW_USER,
//   MLFLOW_PASSWORD. Example usage:
//   MLFLOW_PASSWORD=*** node scripts/live/trace-sink-mlflow.mjs
import process from "node:process";
import { MlflowTraceSource, buildTraceSink } from "../../packages/trace/dist/index.js";

const ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const USER = process.env.MLFLOW_USER ?? "admin";
const PASS = process.env.MLFLOW_PASSWORD ?? "";
const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
const api = async (path, init = {}) => {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

console.log(`trace-sink live e2e — verify create/attach both modes against real MLflow (${ENDPOINT})\n`);

// 0) Server version (to indicate whether span upload is possible) + create a dedicated experiment.
const version = (await api("/version").catch(() => null)) ?? null;
console.log(`server version: ${version ?? "(unavailable — continuing)"}`);
const expName = `everdict-trace-sink-e2e-${Date.now()}`;
const { experiment_id: experimentId } = await api("/api/2.0/mlflow/experiments/create", {
  method: "POST",
  body: JSON.stringify({ name: expName }),
});
console.log(`experiment: ${expName} (id=${experimentId})`);

// 1) create mode — export two cases (trace+scores, including judge:*) through the sink.
const sink = buildTraceSink({ kind: "mlflow", endpoint: ENDPOINT, auth, project: experimentId });
const ctx = { scorecardId: "sc-live-1", dataset: "d@1.0.0", harness: "h@1" };
const mkCase = (caseId) => ({
  caseId,
  trace: [
    { t: 0, kind: "message", role: "user", text: `${caseId} task instruction` },
    {
      t: 10,
      kind: "llm_call",
      model: "gpt-5.4-mini",
      cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
      latencyMs: 5,
    },
    { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
    { t: 30, kind: "tool_result", id: "t1", ok: true, output: "done" },
    { t: 40, kind: "message", role: "assistant", text: "done" },
  ],
  scores: [
    { name: "tests_pass", value: 1, pass: true },
    { name: "judge:quality", value: 0.8, comment: "sufficient evidence" },
  ],
});
const created = await sink.export(ctx, [mkCase("c1"), mkCase("c2")]);
for (const c of created.cases) {
  if (c.error) throw new Error(`✗ create failed (${c.caseId}): ${c.error}`);
  console.log(`create: ${c.caseId} → ${c.externalId}`);
}
console.log(`top url: ${created.url}`);

// 2) Read back — verify via REST that assessments actually attached.
const readAssessments = async (traceId) => {
  const body = await api(`/api/3.0/mlflow/traces/${encodeURIComponent(traceId)}`);
  return (body.trace?.trace_info?.assessments ?? []).map((a) => a.assessment_name);
};
const t1 = created.cases[0].externalId;
const names1 = await readAssessments(t1);
if (!names1.includes("tests_pass") || !names1.includes("judge:quality"))
  throw new Error(`✗ assessments mismatch after create: ${JSON.stringify(names1)}`);
console.log(`✓ create: assessments of ${t1} = ${JSON.stringify(names1)}`);

// 3) attach mode — add scores only onto the same trace (flow ②: attach to the original, no duplication).
const attached = await sink.export(ctx, [
  { caseId: "c1", trace: [], scores: [{ name: "judge:safety", value: 1, pass: true }], externalId: t1 },
]);
if (attached.cases[0]?.error) throw new Error(`✗ attach failed: ${attached.cases[0].error}`);
const names2 = await readAssessments(t1);
if (!names2.includes("judge:safety")) throw new Error(`✗ assessments mismatch after attach: ${JSON.stringify(names2)}`);
console.log(`✓ attach: added judge:safety onto the existing trace → ${JSON.stringify(names2)}`);

// 4) round-trip — read back with MlflowTraceSource. Spans are only uploaded on servers ≥3.12 (OTLP/JSON).
// A <3.12 server rejects OTLP/JSON so there are no spans, and traces/get on a span-less trace throws 500
// ("Trace data not stored in tracking store") — treated as a documented degrade.
const source = new MlflowTraceSource({ endpoint: ENDPOINT, headers: { authorization: auth } });
let events = [];
let spanReadError;
try {
  events = await source.fetch(t1);
} catch (err) {
  spanReadError = String(err?.message ?? err);
  if (!spanReadError.includes("Trace data not stored")) throw err;
}
if (spanReadError) {
  console.log(
    `△ round-trip: server does not accept OTLP/JSON (<3.12) — no spans (${spanReadError.slice(0, 80)}…). Only trace_info+assessments uploaded (documented degrade)`,
  );
} else if (events.length > 0) {
  const llm = events.find((e) => e.kind === "llm_call");
  if (!llm || llm.model !== "gpt-5.4-mini")
    throw new Error(`✗ round-trip normalization mismatch: ${JSON.stringify(events)}`);
  console.log(
    `✓ round-trip: spans normalized into ${events.length} events (llm_call model/tokens match) — server accepts OTLP/JSON (≥3.12)`,
  );
} else {
  console.log(
    "△ round-trip: 0 spans — server does not accept OTLP/JSON (<3.12) so only trace_info+assessments uploaded (documented degrade)",
  );
}

console.log(
  "\n✅ trace-sink live e2e PASS — verified both modes against real MLflow: create (StartTraceV3+assessments) and attach (scores only onto the original trace).",
);
process.exit(0);
