import { Buffer } from "node:buffer";
// Live e2e (SLICE 64): grade SWE-bench in an "environment container" — inside a docker container launched from the env image
// (repo+deps bundled, agent not included), SweBenchGrader decides resolution with real git apply + real pytest. (Official SWE-bench
// approach: the agent only produces a patch, evaluation runs in a prebuilt image container.) Here a small image proves the mechanism for real.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { SweBenchGrader } from "../../packages/graders/dist/index.js";

const IMAGE = "everdict-sweenv:demo";
const BUGGY = "def add(a, b):\n    return a - b  # BUG\n\ndef mul(a, b):\n    return a * b\n";
const FIXED = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n";
const TEST_BASE = "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n";
const TEST_ADD =
  "from calc import add, mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n\ndef test_add():\n    assert add(2, 3) == 5\n";

// 1) Generate valid patches (host git): unified diffs for baseline → fixed(calc) / adding test_add (test).
const wd = mkdtempSync(join(tmpdir(), "swegen-"));
const git = (args) => execFileSync("git", ["-C", wd, ...args], { encoding: "utf8" });
writeFileSync(join(wd, "calc.py"), BUGGY);
writeFileSync(join(wd, "test_calc.py"), TEST_BASE);
git(["init", "-q"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=everdict", "add", "-A"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=everdict", "commit", "-q", "-m", "base"]);
writeFileSync(join(wd, "calc.py"), FIXED);
const GOLD = git(["diff", "--", "calc.py"]);
git(["checkout", "--", "calc.py"]);
writeFileSync(join(wd, "test_calc.py"), TEST_ADD);
const TEST_PATCH = git(["diff", "--", "test_calc.py"]);
rmSync(wd, { recursive: true, force: true });

// 2) Build the env image (repo+deps bundled, no agent = stand-in for the SWE-bench prebuilt). stdin Dockerfile, no context.
const b64 = (s) => Buffer.from(s).toString("base64");
const dockerfile = `FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir -q pytest
WORKDIR /repo
RUN python -c "import base64;open('calc.py','wb').write(base64.b64decode('${b64(BUGGY)}'))"
RUN python -c "import base64;open('test_calc.py','wb').write(base64.b64decode('${b64(TEST_BASE)}'))"
`;
console.log("=== build env image (repo+deps, agent not included) ===");
execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });
console.log(`built ${IMAGE}`);

const driver = new DockerDriver();
const cfg = {
  testPatch: TEST_PATCH,
  failToPass: ["test_calc.py::test_add"],
  passToPass: ["test_calc.py::test_mul"],
  testCmd: "python -m pytest -q --no-header",
  cwd: "/repo",
};
const grader = new SweBenchGrader(cfg);
const ctx = (compute) => ({
  case: {
    id: "calc",
    env: { kind: "repo", source: { files: {} } },
    task: "fix add",
    graders: [],
    timeoutSec: 60,
    tags: [],
  },
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  compute,
});

// 3) Case A — no fix (the agent couldn't fix it). Grade in the env container → FAIL_TO_PASS fails → unresolved.
console.log("\n=== grade in the environment container (real docker exec + real pytest) ===");
const a = await driver.provision({ os: "linux", needs: ["shell"], image: IMAGE });
let aScore;
try {
  aScore = await grader.grade(ctx(a));
} finally {
  await a.dispose();
}
console.log(`[no fix]   resolved=${aScore.pass}  ${String(aScore.detail).split("\n")[0]}`);

// 4) Case B — apply the gold patch (= agent prediction) then grade → F2P passes + P2P holds → resolved.
const b = await driver.provision({ os: "linux", needs: ["shell"], image: IMAGE });
let bScore;
try {
  await b.writeFile("/repo/.pred.patch", GOLD); // agent-predicted patch (injected here)
  const applied = await b.exec("git apply .pred.patch", { cwd: "/repo" });
  console.log(`[gold apply] exit=${applied.exitCode}`);
  bScore = await grader.grade(ctx(b));
} finally {
  await b.dispose();
}
console.log(`[gold fix]  resolved=${bScore.pass}  ${String(bScore.detail).split("\n")[0]}`);

const ok = aScore.pass === false && bScore.pass === true;
console.log(
  ok
    ? "\n✅ SLICE 64: inside a docker container launched from the env image (repo+deps, agent not included), SweBenchGrader grades with real git apply + real pytest — unresolved with no fix, resolved when the gold patch (prediction) is applied. DockerDriver (environment container) = the path that evaluates by launching the official SWE-bench prebuilt as-is, without baking the agent into the image. (Real prebuilt is the same, just a larger image.)"
    : "\n⚠️ Mismatch vs expected",
);
process.exit(ok ? 0 : 1);
