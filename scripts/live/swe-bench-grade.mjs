// 라이브 e2e (SLICE 59): SWE-bench 채점을 실제로 실행 — 실 git apply(test_patch) + 실 pytest 로 resolution 판정.
// 공식 SWE-bench resolution: 에이전트 패치가 적용된 repo 에 gold test_patch 를 입힌 뒤 FAIL_TO_PASS(통과)+
// PASS_TO_PASS(유지) → resolved. per-repo 의존성 설치(공식 prebuilt 이미지)는 인프라; 여기선 "채점"을 실 실행으로 증명.
//
// 자체완결 실 인스턴스(가벼운 repo, 실 pytest): calc.add 버그(a-b) → gold 패치(a+b) 로 고침.
//   test_patch = test_add 추가(FAIL_TO_PASS), 기존 test_mul = PASS_TO_PASS.
// + 실 SWE-bench_Lite 행 1건을 인입해 grader spec(test_patch/F2P/P2P)이 실 데이터로 채워지는지 확인.
import process from "node:process";
import { importBenchmark, getBenchmark } from "../../packages/datasets/dist/index.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { SweBenchGrader } from "../../packages/graders/dist/index.js";

const TESTCMD = "python3 -m pytest -q --no-header";
const GIT = 'git -c user.email=a@b.c -c user.name=assay';

const BUGGY = "def add(a, b):\n    return a - b  # BUG\n\ndef mul(a, b):\n    return a * b\n";
const FIXED = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n";
const TEST_BASE = "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n";
const TEST_WITH_ADD = "from calc import add, mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n\ndef test_add():\n    assert add(2, 3) == 5\n";

const compute = await new LocalDriver().provision({ os: "linux", needs: ["shell"] });

async function sh(cmd) {
  return compute.exec(cmd, { cwd: "work", timeoutSec: 120 });
}

try {
  // 1) baseline repo(버그 + 기존 테스트) 커밋.
  await compute.exec("mkdir -p work");
  await compute.writeFile("work/calc.py", BUGGY);
  await compute.writeFile("work/test_calc.py", TEST_BASE);
  await sh(`git init -q && ${GIT} add -A && ${GIT} commit -q -m baseline`);

  // 2) 실 git diff 로 유효한 패치 생성: gold(calc 수정) + test_patch(test_add 추가). 각각 생성 후 워킹트리 되돌림.
  await compute.writeFile("work/calc.py", FIXED);
  const GOLD_PATCH = (await sh("git diff -- calc.py")).stdout;
  await sh("git checkout -- calc.py");
  await compute.writeFile("work/test_calc.py", TEST_WITH_ADD);
  const TEST_PATCH = (await sh("git diff -- test_calc.py")).stdout;
  await sh("git checkout -- test_calc.py"); // baseline 복귀(버그 + test_add 없음)

  const cfg = {
    testPatch: TEST_PATCH,
    failToPass: ["test_calc.py::test_add"],
    passToPass: ["test_calc.py::test_mul"],
    testCmd: TESTCMD,
  };
  const grader = new SweBenchGrader(cfg);
  const ctx = () => ({
    case: { id: "calc-add", env: { kind: "repo", source: { files: {} } }, task: "fix add", graders: [], timeoutSec: 60, tags: [] },
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    compute,
  });

  // 3) Case A — 수정 없음(버그 그대로). grader 가 test_patch 적용 + pytest → FAIL_TO_PASS 실패 → unresolved.
  console.log("=== SWE-bench 채점 실 실행 (자체완결 인스턴스, 실 pytest) ===");
  const a = await grader.grade(ctx());
  console.log(`\n[no fix]   resolved=${a.pass} value=${a.value}  ${String(a.detail).split("\\n")[0]}`);

  // baseline 복귀(test_patch 적용분 되돌림) 후 gold 패치(=에이전트 예측) 적용 → 다시 채점.
  await sh("git checkout -- . && rm -f .assay_test.patch");
  await compute.writeFile("work/gold.patch", GOLD_PATCH);
  const applied = await sh("git apply gold.patch && rm -f gold.patch");
  console.log(`[gold apply] exit=${applied.exitCode}`);

  // 4) Case B — gold 패치 적용됨. grader → test_patch 적용 + pytest → F2P 통과 + P2P 유지 → resolved.
  const b = await grader.grade(ctx());
  console.log(`[gold fix]  resolved=${b.pass} value=${b.value}  ${String(b.detail).split("\\n")[0]}`);

  // 5) 실 SWE-bench_Lite 행 1건 → grader spec 이 실 데이터로 채워지는지(인입 측).
  console.log("\n=== 실 SWE-bench_Lite 행 → swe-bench grader spec (인입 검증) ===");
  let realOk = false;
  try {
    const ds = await importBenchmark(getBenchmark("swe-bench-lite"), { id: "swe-lite", version: "test" }, { limit: 1 });
    const c = ds.cases[0];
    const sb = c.graders.find((g) => g.id === "swe-bench");
    console.log(`  ${c.id}  env=${c.env.kind}(${c.env.source?.git?.split("/").slice(-2).join("/")})`);
    console.log(`  swe-bench grader: test_patch=${(sb?.config?.testPatch ?? "").length}B  F2P=${sb?.config?.failToPass?.length}  P2P=${sb?.config?.passToPass?.length}`);
    realOk = !!sb && (sb.config.testPatch ?? "").length > 0 && sb.config.failToPass.length > 0;
  } catch (e) {
    console.log(`  (HF 인출 실패: ${(e.message ?? "").slice(0, 80)})`);
  }

  const ok = a.pass === false && b.pass === true && realOk;
  console.log(
    ok
      ? "\n✅ SLICE 59: SWE-bench 채점 실 실행 — 수정 없으면 FAIL_TO_PASS 실패(unresolved), gold 패치 적용 시 F2P 통과+P2P 유지(resolved). 실 git apply + 실 pytest. 실 SWE-bench_Lite 행에서 grader spec(test_patch/F2P/P2P)도 채워짐."
      : "\n⚠️ 기대와 불일치",
  );
  process.exit(ok ? 0 : 1);
} finally {
  await compute.dispose();
}
