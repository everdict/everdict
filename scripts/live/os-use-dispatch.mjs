// Live e2e (SLICE 76): the os-use full loop in *a single dispatch* — proof that, rather than a live orchestration script,
// feeding a single control-plane-issued AgentJob into runAgentJob() runs it end-to-end (provision → seed → agent run → snapshot → VLM grade).
// SLICE73/75 wired driver/grade by hand; here all of that is expressed as AgentJob data.
//
//   AgentJob = {
//     harnessSpec: command(`node /agent.cjs {{task}}`, workDir:/tmp, env:{DISPLAY}),  // desktop agent (baked)
//     evalCase:   { env: os-use(setup: sshd+health+Xvfb+hermes), image, task, graders:[judge useScreenshot] },
//     judge:      { provider:"openai", model } }                                       // control plane loads it into the job
//   runAgentJob: env.kind=os-use → OsUseEnvironment, command harness → run the agent, snapshot → screenshot,
//   makeGradersFromEnv → VLM JudgeGrader. judge verdict in CaseResult.scores.
//
// Image build (prerequisite): see the scripts/live/Dockerfile.hermes-ssh-agent header → everdict-hermes-dispatch:demo
// Key: OPENAI_API_KEY env or infra/litellm/.env (runtime only, never committed).
import { readFileSync } from "node:fs";
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { DockerDriver } from "../../packages/drivers/dist/index.js";

const IMAGE = process.env.HERMES_IMAGE ?? "everdict-hermes-dispatch:demo";

// VLM judge key: where the control plane injects secretEnv (here, from .env/env). Model/provider come via job.judge.
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
  console.error("no VLM key (OPENAI_API_KEY/.env required).");
  process.exit(2);
}

// The AgentJob the control plane dispatches — the entire os-use desktop full task lives in this one object.
const job = {
  harness: { id: "desktop-ssh-agent", version: "1.0.0" },
  harnessSpec: {
    kind: "command",
    id: "desktop-ssh-agent",
    version: "1.0.0",
    workDir: "/tmp", // os-use: no work directory, so absolute path (SLICE76 core change)
    env: { DISPLAY: ":99" },
    setup: [], // the agent is baked into the image (/agent.cjs)
    command: "node /agent.cjs {{task}}",
    trace: { kind: "none" }, // grade on the result (final screen)
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

console.log("=== runAgentJob(AgentJob) — os-use full loop, single dispatch ===");
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
    ? "\n✅ SLICE 76: the os-use desktop full task was dispatched + graded end-to-end via a single AgentJob → runAgentJob(). " +
        "The agent (command harness, baked) fills the SSH form with real OS input so hermes opens a genuine SSH tunnel and enters main, " +
        "and the VLM JudgeGrader passes the OsUseEnvironment snapshot. Via the control-plane path, with no live orchestration."
    : "\n⚠️ does not match expectation (judge.pass not true)",
);
process.exit(ok ? 0 : 1);
