// live connection: drive chatgpt/gpt-5.4-mini served by workclaw/infra's LiteLLM through the Everdict eval loop.
// A declarative command harness (zero code) calls LiteLLM /v1/chat/completions via solve.py seeded into the case →
// writes the model answer to answer.md → RepoEnvironment captures it as a git-diff snapshot. (LocalBackend, host python3/network)
//
// Usage (the key via args/env only — do not commit):
//   OPENAI_API_KEY=<litellm master key> OPENAI_API_BASE=http://localhost:4000 \
//   EVERDICT_MODEL=chatgpt/gpt-5.4-mini node scripts/live/litellm-gpt54mini.mjs
import process from "node:process";
import { LocalBackend } from "../../packages/backends/dist/index.js";

const BASE = process.env.OPENAI_API_BASE ?? "http://localhost:4000";
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.EVERDICT_MODEL ?? "chatgpt/gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) is required.");
  process.exit(1);
}

// caller seeded into the case — calls LiteLLM with OPENAI_API_BASE/KEY/EVERDICT_MODEL (env) + task (arg) → answer.md.
const solve = `import os, sys, json, urllib.request
task = sys.argv[1] if len(sys.argv) > 1 else "hello"
base = os.environ["OPENAI_API_BASE"].rstrip("/")
body = json.dumps({"model": os.environ.get("EVERDICT_MODEL", "chatgpt/gpt-5.4-mini"),
                   "messages": [{"role": "user", "content": task}]}).encode()
req = urllib.request.Request(base + "/v1/chat/completions", data=body,
    headers={"authorization": "Bearer " + os.environ["OPENAI_API_KEY"], "content-type": "application/json"})
ans = json.load(urllib.request.urlopen(req, timeout=120))["choices"][0]["message"]["content"]
open("answer.md", "w").write(ans)
print("wrote answer.md (" + str(len(ans)) + " chars)")
`;

const job = {
  harness: { id: "litellm-gpt54mini", version: "1.0.0" },
  harnessSpec: {
    kind: "command",
    id: "litellm-gpt54mini",
    version: "1.0.0",
    setup: [],
    command: "python3 solve.py {{task}}",
    env: { OPENAI_API_BASE: BASE, OPENAI_API_KEY: KEY, EVERDICT_MODEL: MODEL }, // for the live run (properly the key belongs in the secret store)
    trace: { kind: "none" },
  },
  evalCase: {
    id: "litellm-connect-1",
    env: { kind: "repo", source: { files: { "solve.py": solve } } },
    task: "Write a 3-line haiku about evaluation harnesses. Output only the haiku.",
    graders: [{ id: "steps" }, { id: "latency" }],
    timeoutSec: 180,
    tags: ["live", "litellm", "gpt-5.4-mini"],
  },
};

console.log(`connecting ${MODEL} via ${BASE} …`);
const r = await new LocalBackend().dispatch(job);
console.log("harness :", r.harness);
console.log("changed :", r.snapshot.changedFiles);
console.log("answer  :", JSON.stringify(r.snapshot.diff).slice(0, 200));
const ok = (r.snapshot.changedFiles ?? []).includes("answer.md") && r.snapshot.diff.length > 0;
console.log(
  ok
    ? "\n✅ Everdict → LiteLLM gpt-5.4-mini connection OK (the eval loop captured a real model response)"
    : "\n❌ no answer.md",
);
process.exit(ok ? 0 : 1);
