// 라이브 연결: workclaw/infra 의 LiteLLM 이 서빙하는 chatgpt/gpt-5.4-mini 를 Assay 평가 루프로 구동한다.
// 선언형 command 하니스(코드 0)가 케이스에 시드된 solve.py 로 LiteLLM /v1/chat/completions 를 호출 →
// 모델 답을 answer.md 에 기록 → RepoEnvironment 가 git-diff 스냅샷으로 캡처. (LocalBackend, 호스트 python3/네트워크)
//
// 사용(키는 인자/환경으로만 — 커밋 금지):
//   OPENAI_API_KEY=<litellm master key> OPENAI_API_BASE=http://localhost:4000 \
//   ASSAY_MODEL=chatgpt/gpt-5.4-mini node scripts/live/litellm-gpt54mini.mjs
import process from "node:process";
import { LocalBackend } from "../../packages/backends/dist/index.js";

const BASE = process.env.OPENAI_API_BASE ?? "http://localhost:4000";
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.ASSAY_MODEL ?? "chatgpt/gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) 가 필요합니다.");
  process.exit(1);
}

// 케이스에 시드되는 호출기 — OPENAI_API_BASE/KEY/ASSAY_MODEL(env) + task(arg)로 LiteLLM 호출 → answer.md.
const solve = `import os, sys, json, urllib.request
task = sys.argv[1] if len(sys.argv) > 1 else "hello"
base = os.environ["OPENAI_API_BASE"].rstrip("/")
body = json.dumps({"model": os.environ.get("ASSAY_MODEL", "chatgpt/gpt-5.4-mini"),
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
    env: { OPENAI_API_BASE: BASE, OPENAI_API_KEY: KEY, ASSAY_MODEL: MODEL }, // 라이브용(키는 시크릿 스토어가 정석)
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
  ok ? "\n✅ Assay → LiteLLM gpt-5.4-mini 연결 OK (실제 모델 응답을 평가 루프가 캡처)" : "\n❌ answer.md 없음",
);
process.exit(ok ? 0 : 1);
