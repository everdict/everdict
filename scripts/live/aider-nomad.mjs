// 라이브(Nomad): 실제 aider 가 gpt-5.4-mini(workclaw LiteLLM)로 시드된 버그를 고치고 Everdict 가 tests-pass 로
// 채점한다 — 단 실행은 **실제 Nomad alloc(도커 컨테이너)** 안에서. NomadBackend 가 everdict-agent 이미지를 잡으로
// 띄우고, agent 가 선언형 command 하니스(코드 0)를 해석한다: (aider 사전설치) → aider 실행 → tests-pass.
//
// 준비: nomad agent 가동 + everdict-agent:local 이미지 빌드(python + aider 사전설치 포함).
// 사용: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-agent:local \
//       OPENAI_API_KEY=<litellm key> EVERDICT_MODEL=chatgpt/gpt-5.4-mini node scripts/live/aider-nomad.mjs
//   (LiteLLM 은 호스트 :4000 — 컨테이너→호스트는 기본 172.17.0.1 게이트웨이로 접근. LITELLM_HOST 로 덮어쓰기.)
import process from "node:process";
import { NomadBackend } from "../../packages/backends/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-agent:local";
const KEY = process.env.OPENAI_API_KEY;
// 샌드박스(컨테이너)→호스트는 도커 브리지 게이트웨이(172.17.0.1)가 가장 안정적. LAN IP 는 tcp 는 붙어도
// 모델 완성 응답이 그 경로로 깔끔히 안 오는 경우가 있어 기본값을 게이트웨이로 둔다(LITELLM_HOST 로 덮어쓰기 가능).
const HOST = process.env.LITELLM_HOST ?? "172.17.0.1";
const BASE = process.env.OPENAI_API_BASE ?? `http://${HOST}:4000`;
const MODEL = process.env.EVERDICT_MODEL ?? "chatgpt/gpt-5.4-mini";
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
    // aider 는 everdict-agent 이미지에 사전설치(PATH) → setup 비움. (특정 버전이 필요하면 setup 으로 pip 설치 가능.)
    setup: [],
    command:
      "aider --yes-always --no-git --no-auto-commits --no-show-model-warnings --no-check-update --no-show-release-notes --analytics-disable --no-stream --edit-format whole --model openai/{{model}} --message {{task}} mathutils.py",
    model: MODEL,
    // OPENAI_API_BASE 는 비밀 아님 → spec.env. OPENAI_API_KEY 는 비밀 → secretEnv(아래)로 alloc 에 주입.
    env: { OPENAI_API_BASE: BASE },
    trace: { kind: "none" },
  },
  evalCase: {
    // 유니크 id — Nomad job ID(everdict-<id>)가 매 실행 달라야 죽은 이전 alloc 과 충돌하지 않는다.
    id: `aider-fix-add-nomad-${Date.now().toString(36)}`,
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
    tags: ["live", "aider", "nomad", "litellm"],
  },
};

// OPENAI_API_KEY 를 alloc env 로 주입 → agent process.env → LocalDriver 가 자식(aider)에 상속.
// (정석은 워크스페이스 시크릿 스토어; 라이브 스크립트는 secretEnv 직접 주입으로 동등 동작.)
const backend = new NomadBackend({ addr: ADDR, image: IMAGE, secretEnv: { OPENAI_API_KEY: KEY } });

console.log(
  `Nomad(${ADDR}) → aider(${MODEL} via ${BASE}) in a real alloc … (이미지 풀 없음=local; pip+LLM 으로 수 분 소요 가능)`,
);
const t0 = Date.now();
const r = await backend.dispatch(job);
console.log(`\nharness   : ${r.harness}   (${((Date.now() - t0) / 1000).toFixed(0)}s, in Nomad alloc)`);
console.log("changed   :", r.snapshot.changedFiles);
console.log(
  "scores    :",
  r.scores.map((s) => `${s.graderId}:${s.value}${s.pass != null ? `(${s.pass ? "pass" : "fail"})` : ""}`).join(", "),
);
const tp = r.scores.find((s) => s.graderId === "tests-pass");
if (tp?.detail) console.log("tests-pass detail:", tp.detail.slice(0, 200));
const ok = tp?.pass === true;
if (!ok) {
  // 실패 진단: aider 히스토리(모델 실제 응답)가 스냅샷 diff 에 들어있다.
  const hist = r.snapshot.diff
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .join("\n");
  console.log(`\n--- snapshot diff (aider history; model 응답) tail ---\n${hist.slice(-1500)}`);
}
console.log(
  ok
    ? "\n✅ Nomad alloc 안에서 aider(gpt-5.4-mini) 가 버그 수정 + tests-pass 통과 — 실 OSS 하니스 Nomad 라이브 평가 OK"
    : "\n⚠️ tests-pass 미통과 (위 detail / Nomad alloc 로그 확인)",
);
process.exit(ok ? 0 : 1);
