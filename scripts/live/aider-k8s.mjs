// 라이브(K8s/kind): 실제 aider 가 gpt-5.4-mini(workclaw LiteLLM)로 시드 버그를 고치고 Assay 가 tests-pass 로
// 채점한다 — 실행은 **실제 K8s Job(파드)** 안에서. K8sBackend 가 assay-agent 이미지를 Job 으로 띄우고,
// agent 가 선언형 command 하니스(코드 0)를 해석한다: (aider 사전설치) → aider 실행 → tests-pass.
//
// 준비: kind 클러스터 `assay` + assay-agent:local 이미지(python+aider) 를 kind 노드에 로드
//   docker build -f packages/agent/Dockerfile -t assay-agent:local . && kind load docker-image assay-agent:local --name assay
// 사용: CONTEXT=kind-assay OPENAI_API_KEY=<litellm key> node scripts/live/aider-k8s.mjs
//
// ⚠️ 상태(정직): K8sBackend 디스패치/하니스/aider 설정/모델 도달성(파드에서 urllib)은 모두 검증됨.
// 그러나 이 로컬 kind 에서는 aider 의 litellm/httpx 호출이 hostNetwork 파드 → 호스트(host-network) LiteLLM
// 경로에서 멈춘다(같은 주소로 urllib 은 됨 = httpx/kind-netns 환경 quirk; Assay/모델 문제 아님).
// 운영 정석: LiteLLM 을 in-cluster Service 로 띄워 일반 파드 네트워크로 접근(그러면 httpx 정상).
// aider+모델 실평가는 Local + Nomad 에서 PASS 검증됨(scripts/live/aider-litellm-live.mjs, aider-nomad.mjs).
// (위 hostNetwork 경로를 쓰려면: docker network connect bridge assay-control-plane 로 노드를 기본 브리지에 연결.)
import process from "node:process";
import { K8sBackend } from "../../packages/backends/dist/index.js";

const CONTEXT = process.env.CONTEXT ?? "kind-assay";
const IMAGE = process.env.IMAGE ?? "assay-agent:local";
const NS = process.env.NS ?? "assay-ci";
const KEY = process.env.OPENAI_API_KEY;
const HOST = process.env.LITELLM_HOST ?? "172.17.0.1"; // hostNetwork 파드 → 기본 브리지 게이트웨이 = 호스트
const BASE = process.env.OPENAI_API_BASE ?? `http://${HOST}:4000`;
const MODEL = process.env.ASSAY_MODEL ?? "chatgpt/gpt-5.4-mini";
if (!KEY) {
  console.error("✗ OPENAI_API_KEY (LiteLLM key) 가 필요합니다.");
  process.exit(1);
}

const buggy = "def add(a, b):\n    return a - b\n";

const job = {
  harness: { id: "aider", version: "0.74.0" },
  harnessSpec: {
    kind: "command",
    id: "aider",
    version: "0.74.0",
    setup: [], // aider 사전설치(이미지 PATH)
    command:
      "aider --yes-always --no-git --no-auto-commits --no-show-model-warnings --no-check-update --no-show-release-notes --analytics-disable --no-stream --edit-format whole --model openai/{{model}} --message {{task}} mathutils.py",
    model: MODEL,
    env: { OPENAI_API_BASE: BASE }, // 비밀 아님 → spec.env. 키는 secretEnv(아래).
    trace: { kind: "none" },
  },
  evalCase: {
    id: `aider-fix-add-k8s-${Date.now().toString(36)}`,
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
    tags: ["live", "aider", "k8s", "litellm"],
  },
};

// OPENAI_API_KEY 를 Job 파드 env 로 주입(secretEnv); hostNetwork 로 호스트 LiteLLM 접근(dev).
const backend = new K8sBackend({
  image: IMAGE,
  context: CONTEXT,
  namespace: NS,
  secretEnv: { OPENAI_API_KEY: KEY },
  hostNetwork: true,
});

console.log(`K8s(${CONTEXT}) → aider(${MODEL} via ${BASE}) in a real Job pod (ns=${NS}, hostNetwork) …`);
const t0 = Date.now();
const r = await backend.dispatch(job);
console.log(`\nharness   : ${r.harness}   (${((Date.now() - t0) / 1000).toFixed(0)}s, in K8s Job)`);
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
    ? "\n✅ K8s Job 안에서 aider(gpt-5.4-mini) 가 버그 수정 + tests-pass 통과 — Nomad↔K8s 실 에이전트 패리티 완성"
    : "\n⚠️ tests-pass 미통과 (위 detail 확인)",
);
process.exit(ok ? 0 : 1);
