// live e2e (lifecycle): dispatch a command-harness job via LocalBackend with usage metering on (EVERDICT_METER_USAGE=1).
// The agent (runAgentJob) passes meterUsage to CommandHarness → the harness swaps OPENAI_API_BASE to the local usage-proxy
// → the child (here, the seeded solve.py) calls the real gateway through that proxy → the harvested tokens land as a synthetic
// llm_call in result.trace (the control plane aggregates via budget.settle(costOf(result)) — with no extra code).
//
// Usage: OPENAI_API_KEY=<litellm key> [OPENAI_API_BASE=http://127.0.0.1:4000] node scripts/live/usage-proxy-run.mjs
import process from "node:process";
import { LocalBackend, sumCost } from "../../packages/backends/dist/index.js";

const KEY = process.env.OPENAI_API_KEY;
const BASE = process.env.OPENAI_API_BASE ?? "http://127.0.0.1:4000";
const MODEL = process.env.EVERDICT_MODEL ?? "chatgpt/gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) is required.");
  process.exit(1);
}
process.env.EVERDICT_METER_USAGE = "1"; // read by the agent to turn metering on

// Model caller seeded into the case — calls the real gateway via OPENAI_API_BASE (which the harness swaps to the proxy).
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
    env: { OPENAI_API_BASE: BASE }, // on meterUsage the harness swaps this value to the proxy
    trace: { kind: "none" }, // no self-trace = metering target (black box)
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
const cost = sumCost(r.trace); // the exact value the control plane uses for budget.settle
console.log("changed   :", r.snapshot.changedFiles);
console.log("llm_call  :", JSON.stringify(llm));
console.log("sumCost   :", JSON.stringify(cost), "(usd 0 = subscription model; tokens still metered)");
const ok = llm.length > 0 && cost.tokens > 0;
console.log(
  ok
    ? "\n✅ lifecycle metering OK — synthetic llm_call landed in result.trace → budget.settle(tokens) aggregates automatically"
    : "\n❌ metering failed",
);
process.exit(ok ? 0 : 1);
