// 라이브: 실제 OSS 코딩 에이전트 aider 가 gpt-5.4-mini(workclaw LiteLLM)로 시드된 버그를 고치고,
// Assay 가 tests-pass 로 객관 채점한다. 선언형 command 하니스(코드 0): setup 으로 aider 설치(/tmp venv) →
// command 로 aider 실행 → RepoEnvironment git-diff 스냅샷 + tests-pass 그레이더. (LocalBackend, 호스트 실행)
//
// 사용: OPENAI_API_KEY=<litellm key> OPENAI_API_BASE=http://localhost:4000 \
//       ASSAY_MODEL=chatgpt/gpt-5.4-mini node scripts/live/aider-litellm-live.mjs
import process from "node:process";
import { LocalBackend } from "../../packages/backends/dist/index.js";

const BASE = process.env.OPENAI_API_BASE ?? "http://localhost:4000";
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.ASSAY_MODEL ?? "chatgpt/gpt-5.4-mini";
const VENV = "/tmp/assay-aider";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) 가 필요합니다.");
  process.exit(1);
}

// 시드 레포: add() 가 합이 아니라 차를 반환하는 버그. aider 가 고쳐야 한다.
const buggy = "def add(a, b):\n    return a - b\n";

const job = {
  harness: { id: "aider", version: "0.74.0" },
  harnessSpec: {
    kind: "command",
    id: "aider",
    version: "0.74.0",
    setup: [`python3 -m venv ${VENV}`, `${VENV}/bin/pip install -q --disable-pip-version-check aider-chat`],
    command: `${VENV}/bin/aider --yes --no-git --no-auto-commits --no-show-model-warnings --no-check-update --no-stream --edit-format whole --model openai/{{model}} --message {{task}} mathutils.py`,
    model: MODEL,
    env: { OPENAI_API_BASE: BASE, OPENAI_API_KEY: KEY }, // 라이브용(정석은 시크릿 스토어 주입)
    trace: { kind: "none" },
  },
  evalCase: {
    id: "aider-fix-add",
    env: { kind: "repo", source: { files: { "mathutils.py": buggy } } },
    task: "There is a bug in mathutils.py: add(a, b) should return the sum a + b but it returns the difference. Fix it.",
    graders: [
      {
        id: "tests-pass",
        config: { cmd: "python3 -c \"from mathutils import add; assert add(2,3)==5; print('PASS')\"" },
      },
      { id: "latency" },
    ],
    timeoutSec: 600,
    tags: ["live", "aider", "litellm"],
  },
};

console.log(`aider(${MODEL} via ${BASE}) fixing a seeded bug … (pip install + LLM, may take a few min)`);
const t0 = Date.now();
const r = await new LocalBackend().dispatch(job);
console.log(`\nharness   : ${r.harness}   (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log("changed   :", r.snapshot.changedFiles);
console.log(
  "scores    :",
  r.scores.map((s) => `${s.graderId}:${s.value}${s.pass != null ? `(${s.pass ? "pass" : "fail"})` : ""}`).join(", "),
);
const tp = r.scores.find((s) => s.graderId === "tests-pass");
if (tp?.detail) console.log("tests-pass detail:", tp.detail.slice(0, 200));
const ok = tp?.pass === true;
console.log(
  ok
    ? "\n✅ aider(gpt-5.4-mini) 가 버그를 고쳤고 tests-pass 통과 — 실 OSS 하니스 라이브 평가 OK"
    : "\n⚠️ tests-pass 미통과(에이전트가 못 고침 — 인프라/연결은 동작; 위 detail 참고)",
);
process.exit(0);
