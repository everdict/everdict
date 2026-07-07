// Live e2e (SLICE 59): actually run SWE-bench grading — decide resolution with real git apply (test_patch) + real pytest.
// Official SWE-bench resolution: apply the gold test_patch on top of the agent-patched repo, then FAIL_TO_PASS (passes) +
// PASS_TO_PASS (holds) → resolved. Per-repo dependency install (official prebuilt image) is infra; here we prove "grading" via a real run.
//
// Self-contained real instance (lightweight repo, real pytest): calc.add bug (a-b) → fixed by the gold patch (a+b).
//   test_patch = adds test_add (FAIL_TO_PASS), existing test_mul = PASS_TO_PASS.
// + Ingest one real SWE-bench_Lite row to confirm the grader spec (test_patch/F2P/P2P) is filled from real data.
import process from "node:process";
import { getBenchmark, importBenchmark } from "../../packages/datasets/dist/index.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { SweBenchGrader } from "../../packages/graders/dist/index.js";

const TESTCMD = "python3 -m pytest -q --no-header";
const GIT = "git -c user.email=a@b.c -c user.name=everdict";

const BUGGY = "def add(a, b):\n    return a - b  # BUG\n\ndef mul(a, b):\n    return a * b\n";
const FIXED = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n";
const TEST_BASE = "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n";
const TEST_WITH_ADD =
  "from calc import add, mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n\ndef test_add():\n    assert add(2, 3) == 5\n";

const compute = await new LocalDriver().provision({ os: "linux", needs: ["shell"] });

async function sh(cmd) {
  return compute.exec(cmd, { cwd: "work", timeoutSec: 120 });
}

try {
  // 1) Commit the baseline repo (bug + existing test).
  await compute.exec("mkdir -p work");
  await compute.writeFile("work/calc.py", BUGGY);
  await compute.writeFile("work/test_calc.py", TEST_BASE);
  await sh(`git init -q && ${GIT} add -A && ${GIT} commit -q -m baseline`);

  // 2) Generate valid patches with real git diff: gold (fix calc) + test_patch (add test_add). Revert the working tree after each.
  await compute.writeFile("work/calc.py", FIXED);
  const GOLD_PATCH = (await sh("git diff -- calc.py")).stdout;
  await sh("git checkout -- calc.py");
  await compute.writeFile("work/test_calc.py", TEST_WITH_ADD);
  const TEST_PATCH = (await sh("git diff -- test_calc.py")).stdout;
  await sh("git checkout -- test_calc.py"); // back to baseline (bug + no test_add)

  const cfg = {
    testPatch: TEST_PATCH,
    failToPass: ["test_calc.py::test_add"],
    passToPass: ["test_calc.py::test_mul"],
    testCmd: TESTCMD,
  };
  const grader = new SweBenchGrader(cfg);
  const ctx = () => ({
    case: {
      id: "calc-add",
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

  // 3) Case A — no fix (bug as-is). Grader applies test_patch + pytest → FAIL_TO_PASS fails → unresolved.
  console.log("=== real SWE-bench grading run (self-contained instance, real pytest) ===");
  const a = await grader.grade(ctx());
  console.log(`\n[no fix]   resolved=${a.pass} value=${a.value}  ${String(a.detail).split("\\n")[0]}`);

  // Back to baseline (revert what test_patch applied), then apply the gold patch (= agent prediction) → grade again.
  await sh("git checkout -- . && rm -f .everdict_test.patch");
  await compute.writeFile("work/gold.patch", GOLD_PATCH);
  const applied = await sh("git apply gold.patch && rm -f gold.patch");
  console.log(`[gold apply] exit=${applied.exitCode}`);

  // 4) Case B — gold patch applied. Grader → apply test_patch + pytest → F2P passes + P2P holds → resolved.
  const b = await grader.grade(ctx());
  console.log(`[gold fix]  resolved=${b.pass} value=${b.value}  ${String(b.detail).split("\\n")[0]}`);

  // 5) One real SWE-bench_Lite row → confirm the grader spec is filled from real data (ingest side).
  console.log("\n=== real SWE-bench_Lite row → swe-bench grader spec (ingest verification) ===");
  let realOk = false;
  try {
    const ds = await importBenchmark(getBenchmark("swe-bench-lite"), { id: "swe-lite", version: "test" }, { limit: 1 });
    const c = ds.cases[0];
    const sb = c.graders.find((g) => g.id === "swe-bench");
    console.log(`  ${c.id}  env=${c.env.kind}(${c.env.source?.git?.split("/").slice(-2).join("/")})`);
    console.log(
      `  swe-bench grader: test_patch=${(sb?.config?.testPatch ?? "").length}B  F2P=${sb?.config?.failToPass?.length}  P2P=${sb?.config?.passToPass?.length}`,
    );
    realOk = !!sb && (sb.config.testPatch ?? "").length > 0 && sb.config.failToPass.length > 0;
  } catch (e) {
    console.log(`  (HF fetch failed: ${(e.message ?? "").slice(0, 80)})`);
  }

  const ok = a.pass === false && b.pass === true && realOk;
  console.log(
    ok
      ? "\n✅ SLICE 59: real SWE-bench grading run — no fix → FAIL_TO_PASS fails (unresolved), gold patch applied → F2P passes + P2P holds (resolved). Real git apply + real pytest. The grader spec (test_patch/F2P/P2P) is also filled from a real SWE-bench_Lite row."
      : "\n⚠️ Mismatch vs expected",
  );
  process.exit(ok ? 0 : 1);
} finally {
  await compute.dispose();
}
