// 라이브 e2e (SLICE 90): OtelTraceSource 를 *실제 Jaeger*(assay-jaeger, OTLP in :4318 / query :16686)에 대고 검증.
// 지금까지 trace 매퍼는 mock fetch 로만 단위테스트됐다. 여기선 실 OTLP 스팬을 Jaeger 로 보내고, OtelTraceSource 가
// Jaeger query API(/api/traces/{id})에서 끌어와 정규화 TraceEvent[](llm_call 토큰/모델)로 매핑하는지 라이브로 확인한다.
// = scorecard pull-ingest(POST /scorecards/ingest/pull) + command 하니스 trace 추출 경로의 실 backend 검증.
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
      resource: { attributes: [{ key: "service.name", value: { stringValue: "assay-trace-live" } }] },
      scopeSpans: [{ scope: { name: "assay-live" }, spans: [span] }],
    },
  ],
};

let ok = false;
try {
  console.log("=== OTLP 스팬 전송 → 실 Jaeger ===");
  console.log("traceId:", traceId);
  const post = await fetch(OTLP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(otlp),
  });
  console.log("OTLP POST →", post.status); // 200(빈 partialSuccess)

  console.log("\n=== OtelTraceSource.fetch(traceId) — Jaeger query 에서 끌어와 정규화 ===");
  const src = new OtelTraceSource({ endpoint: QUERY });
  let events = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1000); // Jaeger 인제스트 랙
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
      ? "\n✅ SLICE 90: OtelTraceSource 가 실제 Jaeger 에서 OTLP 스팬을 끌어와 정규화 TraceEvent(llm_call: model=gpt-5.4-mini, in=100/out=42 tokens, usd=0.0012)로 매핑. trace pull 경로(pull-ingest/command 하니스)를 실 backend 로 검증."
      : "\n⚠️ 기대와 불일치(매핑/인제스트)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
}
process.exit(ok ? 0 : 1);
