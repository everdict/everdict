// live: put the LLM usage proxy (@everdict/trace createUsageProxy) in front of the real gateway (workclaw LiteLLM),
// pass requests through, and reclaim per-run token usage. A subscription model (gpt-5.4-mini, $0 unbilled) is measured too, since the tokens are in the response usage.
// A black-box harness (aider, etc.) is instrumented with no code changes as long as its OPENAI_API_BASE points at this proxy.
// (the lifecycle e2e is usage-proxy-run.mjs — the command harness plugs this in automatically.)
//
// Usage: OPENAI_API_KEY=<litellm key> [UPSTREAM=http://127.0.0.1:4000] node scripts/live/usage-proxy.mjs
import process from "node:process";
import { createUsageProxy } from "../../packages/trace/dist/index.js";

const KEY = process.env.OPENAI_API_KEY;
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:4000";
const MODEL = process.env.EVERDICT_MODEL ?? "chatgpt/gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) is required.");
  process.exit(1);
}

const { server, tally } = createUsageProxy({ upstreamBaseUrl: UPSTREAM });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
console.log(`usage-proxy :${port} → ${UPSTREAM}  (model ${MODEL})`);

async function call(run, msg) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-everdict-run": run },
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
console.log(
  ok ? "\n✅ usage-proxy measures per-run tokens from the real gateway response OK" : "\n❌ measurement failed",
);
server.close();
process.exit(ok ? 0 : 1);
