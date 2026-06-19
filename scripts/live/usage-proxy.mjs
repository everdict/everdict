// 라이브: LLM 사용량 프록시(@assay/backends createUsageProxy)를 실제 게이트웨이(workclaw LiteLLM) 앞에 두고,
// 통과시키며 run 단위 토큰 usage 를 회수한다. 구독 모델(gpt-5.4-mini, $0 비과금)도 토큰은 응답 usage 에 있으므로
// 계측된다. 블랙박스 하니스(aider 등)는 OPENAI_API_BASE 만 이 프록시로 향하면 코드 수정 없이 계측됨.
//
// 사용: OPENAI_API_KEY=<litellm key> [UPSTREAM=http://127.0.0.1:4000] node scripts/live/usage-proxy.mjs
import process from "node:process";
import { createUsageProxy } from "../../packages/backends/dist/index.js";

const KEY = process.env.OPENAI_API_KEY;
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:4000";
const MODEL = process.env.ASSAY_MODEL ?? "chatgpt/gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) 가 필요합니다.");
  process.exit(1);
}

const { server, tally } = createUsageProxy({ upstreamBaseUrl: UPSTREAM });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
console.log(`usage-proxy :${port} → ${UPSTREAM}  (model ${MODEL})`);

async function call(run, msg) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-assay-run": run },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: msg }] }),
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.slice(0, 24);
}

console.log("resp A1:", await call("run-A", "say one"));
console.log("resp A2:", await call("run-A", "say two words"));
console.log("resp B1:", await call("run-B", "say three short words"));
console.log("\n=== captured per-run token usage ===");
console.log("run-A:", JSON.stringify(tally.get("run-A")));
console.log("run-B:", JSON.stringify(tally.get("run-B")));
const a = tally.get("run-A");
const b = tally.get("run-B");
const ok = a.calls === 2 && a.totalTokens > 0 && b.calls === 1 && b.totalTokens > 0;
console.log(ok ? "\n✅ usage-proxy 가 실제 게이트웨이 응답에서 run별 토큰 계측 OK" : "\n❌ 계측 실패");
server.close();
process.exit(ok ? 0 : 1);
