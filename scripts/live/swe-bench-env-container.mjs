// 라이브 e2e (SLICE 64): SWE-bench 를 "환경 컨테이너"에서 채점 — 케이스를 env 이미지(repo+deps 동봉, 에이전트 미포함)
// 로 띄운 docker 컨테이너 안에서 SweBenchGrader 가 실 git apply + 실 pytest 로 resolution 판정. (공식 SWE-bench 방식:
// 에이전트는 패치만 만들고, 평가는 prebuilt 이미지 컨테이너에서.) 여기선 작은 이미지로 메커니즘을 실제로 증명.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { SweBenchGrader } from "../../packages/graders/dist/index.js";

const IMAGE = "assay-sweenv:demo";
const BUGGY = "def add(a, b):\n    return a - b  # BUG\n\ndef mul(a, b):\n    return a * b\n";
const FIXED = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n";
const TEST_BASE = "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n";
const TEST_ADD = "from calc import add, mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n\ndef test_add():\n    assert add(2, 3) == 5\n";

// 1) 유효 패치 생성(호스트 git): baseline → fixed(calc) / test_add 추가(test) 의 unified diff.
const wd = mkdtempSync(join(tmpdir(), "swegen-"));
const git = (args) => execFileSync("git", ["-C", wd, ...args], { encoding: "utf8" });
writeFileSync(join(wd, "calc.py"), BUGGY);
writeFileSync(join(wd, "test_calc.py"), TEST_BASE);
git(["init", "-q"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=assay", "add", "-A"]);
git(["-c", "user.email=a@b.c", "-c", "user.name=assay", "commit", "-q", "-m", "base"]);
writeFileSync(join(wd, "calc.py"), FIXED);
const GOLD = git(["diff", "--", "calc.py"]);
git(["checkout", "--", "calc.py"]);
writeFileSync(join(wd, "test_calc.py"), TEST_ADD);
const TEST_PATCH = git(["diff", "--", "test_calc.py"]);
rmSync(wd, { recursive: true, force: true });

// 2) env 이미지 빌드(repo+deps 동봉, 에이전트 없음 = SWE-bench prebuilt 대역). 컨텍스트 없이 stdin Dockerfile.
const b64 = (s) => Buffer.from(s).toString("base64");
const dockerfile = `FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir -q pytest
WORKDIR /repo
RUN python -c "import base64;open('calc.py','wb').write(base64.b64decode('${b64(BUGGY)}'))"
RUN python -c "import base64;open('test_calc.py','wb').write(base64.b64decode('${b64(TEST_BASE)}'))"
`;
console.log("=== env 이미지 빌드(repo+deps, 에이전트 미포함) ===");
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
  case: { id: "calc", env: { kind: "repo", source: { files: {} } }, task: "fix add", graders: [], timeoutSec: 60, tags: [] },
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  compute,
});

// 3) Case A — 수정 없음(에이전트가 못 고침). env 컨테이너에서 채점 → FAIL_TO_PASS 실패 → unresolved.
console.log("\n=== 환경 컨테이너에서 채점 (실 docker exec + 실 pytest) ===");
const a = await driver.provision({ os: "linux", needs: ["shell"], image: IMAGE });
let aScore;
try {
  aScore = await grader.grade(ctx(a));
} finally {
  await a.dispose();
}
console.log(`[no fix]   resolved=${aScore.pass}  ${String(aScore.detail).split("\n")[0]}`);

// 4) Case B — gold 패치(=에이전트 예측) 적용 후 채점 → F2P 통과 + P2P 유지 → resolved.
const b = await driver.provision({ os: "linux", needs: ["shell"], image: IMAGE });
let bScore;
try {
  await b.writeFile("/repo/.pred.patch", GOLD); // 에이전트 예측 패치(여기선 주입)
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
    ? "\n✅ SLICE 64: 케이스를 env 이미지(repo+deps, 에이전트 미포함)로 띄운 docker 컨테이너에서 SweBenchGrader 가 실 git apply + 실 pytest 로 채점 — 수정 없으면 unresolved, gold 패치(예측) 적용 시 resolved. DockerDriver(환경 컨테이너) = 에이전트를 이미지에 굽지 않고 공식 SWE-bench prebuilt 를 그대로 띄워 평가하는 경로. (실 prebuilt 는 동일 방식, 이미지만 큼.)"
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
