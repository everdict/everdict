import { Buffer } from "node:buffer";
// 라이브 e2e (SLICE 66): in-image repo env-mode — 코딩 에이전트가 prebuilt 이미지의 repo(/testbed)에 직접 작업.
// 완전 자율 흐름(실 docker, full runCase): DockerDriver 가 env 이미지로 컨테이너 → RepoEnvironment(source:{path:/testbed})
// 가 clone 없이 work→/testbed 심볼릭링크 → 하니스(에이전트)가 /testbed 의 코드를 고침 → SweBenchGrader 가 /testbed 에서
// test_patch 적용 + pytest → resolved. (실 SWE-bench prebuilt 도 동일: 이미지에 repo@base_commit + deps 동봉.)
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

// 1) gold test_patch 생성(호스트 git): baseline → test_add 추가.
const wd = mkdtempSync(join(tmpdir(), "tb-"));
const git = (a) => execFileSync("git", ["-C", wd, ...a], { encoding: "utf8" });
writeFileSync(join(wd, "test_calc.py"), TEST_BASE);
git(["init", "-q"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=everdict", "add", "-A"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=everdict", "commit", "-q", "-m", "base"]);
writeFileSync(join(wd, "test_calc.py"), TEST_ADD);
const TEST_PATCH = git(["diff", "--", "test_calc.py"]);
rmSync(wd, { recursive: true, force: true });

// 2) prebuilt 대역 이미지: /testbed = git repo(버그 + 기존 테스트) @ baseline, deps(pytest) 동봉. 에이전트 미포함.
const dockerfile = `FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir -q pytest
RUN mkdir -p /testbed
WORKDIR /testbed
RUN python -c "import base64;open('calc.py','wb').write(base64.b64decode('${b64(BUGGY)}'))" \\
 && python -c "import base64;open('test_calc.py','wb').write(base64.b64decode('${b64(TEST_BASE)}'))" \\
 && git init -q && git -c user.email=a@b.c -c user.name=everdict add -A && git -c user.email=a@b.c -c user.name=everdict commit -q -m base
`;
console.log("=== prebuilt 대역 이미지 빌드(/testbed repo@baseline + deps, 에이전트 미포함) ===");
execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });

const evalCase = {
  id: "calc-add",
  env: { kind: "repo", source: { path: "/testbed" } }, // 이미지-내 repo — clone 안 함
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
  // cwd 기본 "work" → 컨테이너에서 /everdict/work → /testbed 심볼릭링크
});
// "에이전트": work(=/testbed) 의 calc.py 를 고친다. (실 코딩 에이전트 자리 — 여기선 scripted.)
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

console.log("\n=== 에이전트가 /testbed 에 직접 작업 → /testbed 에서 채점 (실 docker + 실 pytest) ===");
const fixed = await run("agent fixes", fixPlan);
const noop = await run("no fix    ", noopPlan);

execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });

const ok = fixed?.pass === true && (fixed?.changed ?? []) && noop?.pass === false;
console.log(
  ok
    ? "\n✅ SLICE 66: in-image repo env-mode — RepoEnvironment(source:{path:/testbed})가 clone 없이 work→/testbed 링크 → 에이전트(scripted)가 이미지의 repo 를 직접 고침 → SweBenchGrader 가 /testbed 에서 test_patch+pytest → 고치면 resolved, 안 고치면 unresolved. 실 prebuilt 이미지로 SWE-bench 완전 자율 실행 경로 완성(deps+repo 는 이미지, 에이전트는 안 구움)."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
