// 라이브 e2e(라이프사이클): command 하니스 잡을 LocalBackend 로 디스패치하면서 사용량 계측을 켠다(EVERDICT_METER_USAGE=1).
// 에이전트(runAgentJob)가 CommandHarness 에 meterUsage 를 넘김 → 하니스가 OPENAI_API_BASE 를 로컬 usage-proxy 로
// 바꿔치기 → 자식(여기선 시드된 solve.py)이 그 프록시로 실제 게이트웨이를 호출 → 회수된 토큰이 합성 llm_call 로
// result.trace 에 실린다(컨트롤플레인은 budget.settle(costOf(result)) 로 집계 — 별도 코드 없이).
//
// 사용: OPENAI_API_KEY=<litellm key> [OPENAI_API_BASE=http://127.0.0.1:4000] node scripts/live/usage-proxy-run.mjs
import process from "node:process";
import { LocalBackend, sumCost } from "../../packages/backends/dist/index.js";

const KEY = process.env.OPENAI_API_KEY;
const BASE = process.env.OPENAI_API_BASE ?? "http://127.0.0.1:4000";
const MODEL = process.env.EVERDICT_MODEL ?? "chatgpt/gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) 가 필요합니다.");
  process.exit(1);
}
process.env.EVERDICT_METER_USAGE = "1"; // 에이전트가 읽어 계측 on

// 케이스에 시드되는 모델 호출기 — OPENAI_API_BASE(=하니스가 프록시로 바꿔침)로 실제 게이트웨이 호출.
const solve = `import os, sys, json, urllib.request
task = sys.argv[1] if len(sys.argv) > 1 else "hi"
base = os.environ["OPENAI_API_BASE"].rstrip("/")
body = json.dumps({"model": os.environ.get("EVERDICT_MODEL", "chatgpt/gpt-5.4-mini"),
                   "messages": [{"role": "user", "content": task}]}).encode()
req = urllib.request.Request(base + "/v1/chat/completions", data=body,
    headers={"authorization": "Bearer " + os.environ["OPENAI_API_KEY"], "content-type": "application/json"})
open("answer.md", "w").write(json.load(urllib.request.urlopen(req, timeout=120))["choices"][0]["message"]["content"])
`;

const job = {
  harness: { id: "litellm-call", version: "1.0.0" },
  harnessSpec: {
    kind: "command",
    id: "litellm-call",
    version: "1.0.0",
    setup: [],
    command: "python3 solve.py {{task}}",
    model: MODEL,
    env: { OPENAI_API_BASE: BASE }, // 하니스가 meterUsage 시 이 값을 프록시로 바꿔치기
    trace: { kind: "none" }, // 자기 트레이스 없음 = 계측 대상(블랙박스)
  },
  evalCase: {
    id: `usage-${Date.now().toString(36)}`,
    env: { kind: "repo", source: { files: { "solve.py": solve } } },
    task: "Say a short one-line hello.",
    graders: [{ id: "latency" }],
    timeoutSec: 120,
    tags: ["live", "usage"],
  },
};

console.log(`dispatch (meter ON) → ${MODEL} via ${BASE} …`);
const r = await new LocalBackend().dispatch(job);
const llm = r.trace.filter((e) => e.kind === "llm_call");
const cost = sumCost(r.trace); // 컨트롤플레인이 budget.settle 에 쓰는 바로 그 값
console.log("changed   :", r.snapshot.changedFiles);
console.log("llm_call  :", JSON.stringify(llm));
console.log("sumCost   :", JSON.stringify(cost), "(usd 0 = 구독모델; 토큰은 계측됨)");
const ok = llm.length > 0 && cost.tokens > 0;
console.log(
  ok
    ? "\n✅ 라이프사이클 계측 OK — 합성 llm_call 이 result.trace 에 실림 → budget.settle(tokens) 자동 집계"
    : "\n❌ 계측 실패",
);
process.exit(ok ? 0 : 1);
