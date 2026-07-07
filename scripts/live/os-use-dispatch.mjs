// 라이브 e2e (SLICE 76): os-use 풀 루프를 *한 번의 디스패치*로 — 라이브 오케스트레이션 스크립트가 아니라
// 컨트롤플레인이 보내는 AgentJob 한 개를 runAgentJob() 에 넣으면 끝까지(프로비전→seed→에이전트 구동→스냅샷→VLM 채점)
// 돌아간다는 증명. SLICE73/75 는 손으로 driver/grade 를 엮었고, 여기선 그게 전부 AgentJob 데이터로 표현된다.
//
//   AgentJob = {
//     harnessSpec: command(`node /agent.cjs {{task}}`, workDir:/tmp, env:{DISPLAY}),  // 데스크탑 에이전트(baked)
//     evalCase:   { env: os-use(setup: sshd+health+Xvfb+hermes), image, task, graders:[judge useScreenshot] },
//     judge:      { provider:"openai", model } }                                       // 컨트롤플레인이 잡에 실음
//   runAgentJob 가: env.kind=os-use → OsUseEnvironment, command 하니스 → 에이전트 실행, snapshot → 스크린샷,
//   makeGradersFromEnv → VLM JudgeGrader. CaseResult.scores 에 judge 판정.
//
// 이미지 빌드(사전): scripts/live/Dockerfile.hermes-ssh-agent 헤더 참고 → everdict-hermes-dispatch:demo
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env (런타임에만, 커밋 안 함).
import { readFileSync } from "node:fs";
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { DockerDriver } from "../../packages/drivers/dist/index.js";

const IMAGE = process.env.HERMES_IMAGE ?? "everdict-hermes-dispatch:demo";

// VLM judge 키: 컨트롤플레인이 secretEnv 로 주입하는 자리(여기선 .env/env 에서). 모델/프로바이더는 job.judge 로 온다.
function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8");
    return (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
process.env.OPENAI_API_KEY = masterKey() ?? "";
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1";
if (!process.env.OPENAI_API_KEY) {
  console.error("VLM 키 없음(OPENAI_API_KEY/.env 필요).");
  process.exit(2);
}

// 컨트롤플레인이 디스패치하는 AgentJob — os-use 데스크탑 풀 태스크 전체가 이 한 객체에 들어있다.
const job = {
  harness: { id: "desktop-ssh-agent", version: "1.0.0" },
  harnessSpec: {
    kind: "command",
    id: "desktop-ssh-agent",
    version: "1.0.0",
    workDir: "/tmp", // os-use: work 디렉터리가 없으므로 절대경로(SLICE76 core 변경)
    env: { DISPLAY: ":99" },
    setup: [], // 에이전트는 이미지에 baked(/agent.cjs)
    command: "node /agent.cjs {{task}}",
    trace: { kind: "none" }, // 결과(최종 화면) 기반 채점
  },
  evalCase: {
    id: "hermes-ssh-task",
    env: {
      kind: "os-use",
      display: ":99",
      setup: [
        "mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh",
        "ssh-keygen -A",
        "test -f /root/.ssh/id_rsa || ssh-keygen -t ed25519 -f /root/.ssh/id_rsa -N '' -q",
        "cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys",
        "grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config",
        "/usr/sbin/sshd",
        'node -e \'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(8642,"127.0.0.1")\' >/tmp/health.log 2>&1 & sleep 1',
        "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
        "cd /app && ENABLE_CDP=1 CDP_PORT=9222 DISPLAY=:99 ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage >/tmp/electron.log 2>&1 & sleep 10",
      ],
      screenshotPath: "/tmp/osuse.png",
    },
    image: IMAGE,
    task: "Connect Hermes to the SSH server at 127.0.0.1 as user root (key /root/.ssh/id_rsa).",
    graders: [
      {
        id: "judge",
        config: {
          useScreenshot: true,
          rubric:
            "PASS only if the app has advanced PAST the SSH connection form — e.g. a splash like 'Starting SSH tunnel…' " +
            "or the main app screen (sidebar with Chat/Discover, an 'Ask anything' box) — with NO connection-error " +
            "message. The SSH connection form itself or a red connection error is NOT the goal.",
        },
      },
    ],
    timeoutSec: 300,
    tags: ["os-use", "ssh"],
  },
  judge: { provider: "openai", model: process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini" },
};

console.log("=== runAgentJob(AgentJob) — os-use 풀 루프 단일 디스패치 ===");
console.log("harness:", job.harnessSpec.kind, job.harnessSpec.command, "| judge:", job.judge.model);
const result = await runAgentJob(job, { driver: new DockerDriver() });

const judgeScore = result.scores.find((s) => s.metric === "judge");
console.log("\n--- CaseResult ---");
console.log("snapshot.kind   =", result.snapshot.kind);
console.log(
  "scores          =",
  JSON.stringify(result.scores.map((s) => ({ id: s.graderId, pass: s.pass, value: s.value }))),
);
console.log("judge.pass      =", judgeScore?.pass, " score=", judgeScore?.value);
console.log("judge.detail    =", String(judgeScore?.detail).slice(0, 220));

try {
  const { execFileSync } = await import("node:child_process");
  if (!process.env.KEEP_IMAGE) {
    execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
    execFileSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });
  }
} catch {}

const ok = result.snapshot.kind === "os-use" && judgeScore?.pass === true;
console.log(
  ok
    ? "\n✅ SLICE 76: os-use 데스크탑 풀 태스크가 단일 AgentJob → runAgentJob() 로 end-to-end 디스패치+채점됨. " +
        "에이전트(command 하니스, baked) 가 SSH 폼을 실 OS 입력으로 채워 hermes 가 진짜 SSH 터널을 열고 메인 진입, " +
        "OsUseEnvironment 스냅샷을 VLM JudgeGrader 가 pass 판정. 라이브 오케스트레이션 없이 컨트롤플레인 경로로."
    : "\n⚠️ 기대와 불일치(judge.pass 아님)",
);
process.exit(ok ? 0 : 1);
