// 라이브 e2e (SLICE 72): os-use env kind — 데스크탑(OS) 컴퓨터-유즈를 1급 환경으로. 호스트에 GUI 스택이 없어
// docker env-container(Xvfb 포함) 안에서 데스크탑을 띄우고 OsUseEnvironment 가 스크린샷으로 관측. (OSWorld/hermes-desktop 류.)
// 메커니즘 검증: Xvfb + 경량 GUI(xclock) → OsUseEnvironment.seed(디스플레이/앱 기동) → snapshot(scrot 캡처) → 실 스크린샷.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { OsUseEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";

const IMAGE = "everdict-osdesk:demo";

// 데스크탑 컴퓨트 이미지: Xvfb(가상 디스플레이) + scrot(스크린샷) + wmctrl(창목록) + x11-apps(xclock GUI).
const dockerfile =
  "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends xvfb scrot wmctrl x11-apps && rm -rf /var/lib/apt/lists/*\n";
console.log("=== 데스크탑 이미지 빌드(Xvfb + scrot + x11-apps) ===");
execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });

// os-use 케이스: 데스크탑 기동 setup + 스크린샷 경로. (실 벤치마크면 graderBuilder/judge 가 스크린샷을 VLM 으로 채점.)
const osCase = {
  id: "desktop-1",
  env: {
    kind: "os-use",
    display: ":99",
    setup: ["Xvfb :99 -screen 0 1024x768x24 -nolisten tcp & sleep 1.5", "xclock -digital -update 1 & sleep 1.5"],
    screenshotPath: "/tmp/everdict-screen.png",
  },
  image: IMAGE,
  task: "Observe the desktop.",
  graders: [],
  timeoutSec: 120,
  tags: [],
};

// "에이전트": 실제론 화면을 보고 마우스/키보드(computer-use). 여기선 no-op(메커니즘 = env 기동+관측 검증).
const noopHarness = {
  id: "noop",
  version: "1.0.0",
  async install() {},
  async *run(_c, task) {
    yield { t: 0, kind: "message", role: "user", text: task };
    yield { t: 1, kind: "message", role: "assistant", text: "observed the desktop" };
  },
};
// 스크린샷이 실제로 캡처됐는지(비어있지 않은 PNG) 검증하는 grader — 컨테이너 안에서.
const grader = makeGraders([
  {
    id: "command",
    config: {
      cmd: 's=$(wc -c < /tmp/everdict-screen.png); echo "screenshot bytes=$s"; test "$s" -gt 1000',
      cwd: "/tmp", // os-use env 은 RepoEnvironment 처럼 work 디렉터리를 만들지 않음 → 존재하는 절대경로 사용
      metric: "screenshot",
    },
  },
]);

console.log("\n=== os-use eval: 컨테이너 데스크탑 기동 → 스크린샷 관측 ===");
const result = await runCase(osCase, {
  driver: new DockerDriver(),
  environment: new OsUseEnvironment(),
  harness: noopHarness,
  graders: grader,
  runCtx: { apiKeyEnv: {}, timeoutSec: 120 },
});
const shot = result.scores.find((s) => s.metric === "screenshot");
console.log(`snapshot.kind   = ${result.snapshot.kind}`);
console.log(`snapshot.screenshotRef = ${result.snapshot.screenshotRef}`);
console.log(`snapshot.windows = ${JSON.stringify(result.snapshot.windows)}`);
console.log(`screenshot grader: pass=${shot?.pass}  ${String(shot?.detail).split("\n")[0]}`);

execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
execFileSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });

const ok = result.snapshot.kind === "os-use" && shot?.pass === true;
console.log(
  ok
    ? "\n✅ SLICE 72: os-use env kind — 데스크탑(OS)을 docker env-container(Xvfb)에서 띄우고 OsUseEnvironment 가 seed(디스플레이/앱 기동) + snapshot(scrot 스크린샷)으로 관측. 실 X 데스크탑 + 실 스크린샷 캡처(비어있지 않은 PNG). 컴퓨터-유즈(OSWorld/hermes-desktop) 평가의 1급 환경 경로."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
