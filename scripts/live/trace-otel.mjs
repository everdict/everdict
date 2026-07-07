// live e2e (SLICE 90): OtelTraceSource verified against a *real Jaeger* (everdict-jaeger, OTLP in :4318 / query :16686).
// Until now the trace mapper was only unit-tested with a mock fetch. Here we send real OTLP spans to Jaeger and verify, live,
// that OtelTraceSource pulls from the Jaeger query API (/api/traces/{id}) and maps to a normalized TraceEvent[] (llm_call tokens/model).
// = real-backend verification of the scorecard pull-ingest (POST /scorecards/ingest/pull) + command harness trace extraction path.
import { randomBytes } from "node:crypto";
import process from "node:process";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const OTLP = process.env.OTLP_URL ?? "http://localhost:4318/v1/traces"; // Jaeger OTLP HTTP in
const QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686"; // Jaeger query API
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const traceId = randomBytes(16).toString("hex"); // 32 hex
const spanId = randomBytes(8).toString("hex"); // 16 hex
const nowNs = BigInt(Date.now()) * 1_000_000n;
const span = {
  traceId,
  spanId,
  name: "chat gpt-5.4-mini",
  kind: 1,
  startTimeUnixNano: String(nowNs),
  endTimeUnixNano: String(nowNs + 1_500_000_000n), // +1.5s
  attributes: [
    { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4-mini" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: "42" } },
    { key: "gen_ai.usage.cost", value: { doubleValue: 0.0012 } },
  ],
};
const otlp = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "everdict-trace-live" } }] },
      scopeSpans: [{ scope: { name: "everdict-live" }, spans: [span] }],
    },
  ],
};

let ok = false;
try {
  console.log("=== send OTLP spans → real Jaeger ===");
  console.log("traceId:", traceId);
  const post = await fetch(OTLP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(otlp),
  });
  console.log("OTLP POST →", post.status); // 200 (empty partialSuccess)

  console.log("\n=== OtelTraceSource.fetch(traceId) — pull from Jaeger query and normalize ===");
  const src = new OtelTraceSource({ endpoint: QUERY });
  let events = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1000); // Jaeger ingest lag
    try {
      events = await src.fetch(traceId);
    } catch {
      events = [];
    }
    if (events.length > 0) break;
  }
  console.log("TraceEvent[]:", JSON.stringify(events));
  const llm = events.find((e) => e.kind === "llm_call");
  ok =
    !!llm &&
    llm.model === "gpt-5.4-mini" &&
    llm.cost?.inputTokens === 100 &&
    llm.cost?.outputTokens === 42 &&
    Math.abs((llm.cost?.usd ?? 0) - 0.0012) < 1e-9;
  console.log(
    ok
      ? "\n✅ SLICE 90: OtelTraceSource pulls OTLP spans from real Jaeger and maps them to a normalized TraceEvent (llm_call: model=gpt-5.4-mini, in=100/out=42 tokens, usd=0.0012). Verifies the trace pull path (pull-ingest/command harness) against a real backend."
      : "\n⚠️ mismatch with expected (mapping/ingest)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
}
process.exit(ok ? 0 : 1);
