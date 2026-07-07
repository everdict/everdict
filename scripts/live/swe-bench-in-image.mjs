import { Buffer } from "node:buffer";
// Live e2e (SLICE 66): in-image repo env-mode — the coding agent works directly on the prebuilt image's repo (/testbed).
// Fully autonomous flow (real docker, full runCase): DockerDriver launches a container from the env image → RepoEnvironment(source:{path:/testbed})
// symlinks work→/testbed without cloning → the harness (agent) fixes the code in /testbed → SweBenchGrader, in /testbed,
// applies test_patch + pytest → resolved. (The real SWE-bench prebuilt is the same: the image bundles repo@base_commit + deps.)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { SweBenchGrader } from "../../packages/graders/dist/index.js";
import { ScriptedHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";

const IMAGE = "everdict-testbed:demo";
const BUGGY = "def add(a, b):\n    return a - b  # BUG\n\ndef mul(a, b):\n    return a * b\n";
const FIXED = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n";
const TEST_BASE = "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n";
const TEST_ADD =
  "from calc import add, mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n\ndef test_add():\n    assert add(2, 3) == 5\n";
const b64 = (s) => Buffer.from(s).toString("base64");

// 1) Generate the gold test_patch (host git): baseline → add test_add.
const wd = mkdtempSync(join(tmpdir(), "tb-"));
const git = (a) => execFileSync("git", ["-C", wd, ...a], { encoding: "utf8" });
writeFileSync(join(wd, "test_calc.py"), TEST_BASE);
git(["init", "-q"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=everdict", "add", "-A"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=everdict", "commit", "-q", "-m", "base"]);
writeFileSync(join(wd, "test_calc.py"), TEST_ADD);
const TEST_PATCH = git(["diff", "--", "test_calc.py"]);
rmSync(wd, { recursive: true, force: true });

// 2) Stand-in for the prebuilt image: /testbed = git repo (bug + existing test) @ baseline, deps (pytest) bundled. Agent not included.
const dockerfile = `FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir -q pytest
RUN mkdir -p /testbed
WORKDIR /testbed
RUN python -c "import base64;open('calc.py','wb').write(base64.b64decode('${b64(BUGGY)}'))" \\
 && python -c "import base64;open('test_calc.py','wb').write(base64.b64decode('${b64(TEST_BASE)}'))" \\
 && git init -q && git -c user.email=a@b.c -c user.name=everdict add -A && git -c user.email=a@b.c -c user.name=everdict commit -q -m base
`;
console.log("=== build prebuilt stand-in image (/testbed repo@baseline + deps, agent not included) ===");
execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });

const evalCase = {
  id: "calc-add",
  env: { kind: "repo", source: { path: "/testbed" } }, // in-image repo — no clone
  image: IMAGE,
  task: "Fix add() in /testbed/calc.py so the added test passes (should return a+b).",
  graders: [],
  timeoutSec: 120,
  tags: [],
};
const grader = new SweBenchGrader({
  testPatch: TEST_PATCH,
  failToPass: ["test_calc.py::test_add"],
  passToPass: ["test_calc.py::test_mul"],
  testCmd: "python -m pytest -q --no-header",
  // cwd defaults to "work" → /everdict/work in the container → symlink to /testbed
});
// "agent": fixes calc.py in work (=/testbed). (Placeholder for a real coding agent — scripted here.)
const fixPlan = () => [{ tool: "bash", cmd: `echo ${b64(FIXED)} | base64 -d > calc.py` }];
const noopPlan = () => [];

async function run(label, plan) {
  const result = await runCase(evalCase, {
    driver: new DockerDriver(),
    environment: new RepoEnvironment(),
    harness: new ScriptedHarness("1.0.0", plan),
    graders: [grader],
    runCtx: { apiKeyEnv: {}, timeoutSec: 300 },
  });
  const r = result.scores.find((s) => s.metric === "resolved");
  console.log(
    `[${label}] resolved=${r?.pass}  changed=${JSON.stringify(result.snapshot.changedFiles)}  ${String(r?.detail).split("\n")[0]}`,
  );
  return r;
}

console.log("\n=== agent works directly on /testbed → grade in /testbed (real docker + real pytest) ===");
const fixed = await run("agent fixes", fixPlan);
const noop = await run("no fix    ", noopPlan);

execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });

const ok = fixed?.pass === true && (fixed?.changed ?? []) && noop?.pass === false;
console.log(
  ok
    ? "\n✅ SLICE 66: in-image repo env-mode — RepoEnvironment(source:{path:/testbed}) links work→/testbed without cloning → the agent (scripted) fixes the image's repo directly → SweBenchGrader runs test_patch+pytest in /testbed → resolved if fixed, unresolved if not. Completes the fully-autonomous SWE-bench run path with a real prebuilt image (deps+repo in the image, agent not baked in)."
    : "\n⚠️ Mismatch vs expected",
);
process.exit(ok ? 0 : 1);
