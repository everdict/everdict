// Live e2e (SLICE 72): os-use env kind — desktop (OS) computer-use as a first-class environment. The host has no GUI stack,
// so we bring up a desktop inside a docker env-container (with Xvfb) and OsUseEnvironment observes it via screenshot. (OSWorld/hermes-desktop style.)
// Mechanism verification: Xvfb + lightweight GUI (xclock) → OsUseEnvironment.seed (start display/app) → snapshot (scrot capture) → real screenshot.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { OsUseEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";

const IMAGE = "everdict-osdesk:demo";

// Desktop compute image: Xvfb (virtual display) + scrot (screenshot) + wmctrl (window list) + x11-apps (xclock GUI).
const dockerfile =
  "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends xvfb scrot wmctrl x11-apps && rm -rf /var/lib/apt/lists/*\n";
console.log("=== build desktop image (Xvfb + scrot + x11-apps) ===");
execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });

// os-use case: desktop-start setup + screenshot path. (For a real benchmark, graderBuilder/judge would grade the screenshot with a VLM.)
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

// "agent": in reality it looks at the screen and uses mouse/keyboard (computer-use). Here it's a no-op (mechanism = verify env start + observation).
const noopHarness = {
  id: "noop",
  version: "1.0.0",
  async install() {},
  async *run(_c, task) {
    yield { t: 0, kind: "message", role: "user", text: task };
    yield { t: 1, kind: "message", role: "assistant", text: "observed the desktop" };
  },
};
// grader that verifies the screenshot was actually captured (non-empty PNG) — inside the container.
const grader = makeGraders([
  {
    id: "command",
    config: {
      cmd: 's=$(wc -c < /tmp/everdict-screen.png); echo "screenshot bytes=$s"; test "$s" -gt 1000',
      cwd: "/tmp", // the os-use env does not create a work directory like RepoEnvironment → use an existing absolute path
      metric: "screenshot",
    },
  },
]);

console.log("\n=== os-use eval: start container desktop → observe screenshot ===");
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
    ? "\n✅ SLICE 72: os-use env kind — a desktop (OS) brought up in a docker env-container (Xvfb) and observed by OsUseEnvironment via seed (start display/app) + snapshot (scrot screenshot). Real X desktop + real screenshot capture (non-empty PNG). First-class environment path for computer-use (OSWorld/hermes-desktop) evaluation."
    : "\n⚠️ does not match expectation",
);
process.exit(ok ? 0 : 1);
