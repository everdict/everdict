// 라이브 e2e (SLICE 68): 실 SWE-bench_Lite 인스턴스 1건을 실 공식 prebuilt 이미지로 풀 실행.
// 이미지(repo@base_commit + 실 conda deps 동봉) → DockerDriver 컨테이너 → SweBenchGrader 가 실 test_patch + 실 pytest.
//   gold patch(데이터셋 정답 = 에이전트 예측 자리) 주입 → FAIL_TO_PASS 통과 → resolved.   미적용 → 실패 → unresolved.
// 오프라인 샌드박스라 PASS_TO_PASS(네트워크 의존 가능)는 제외 — FAIL_TO_PASS 가 버그-수정 판별 신호.
import process from "node:process";
import { sweBenchImage } from "../../packages/datasets/dist/index.js";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { SweBenchGrader } from "../../packages/graders/dist/index.js";

const INSTANCE = process.env.SWE_INSTANCE ?? "psf__requests-3362";

// 1) 인스턴스 행(gold patch / test_patch / FAIL_TO_PASS) — HF datasets-server.
const url = `https://datasets-server.huggingface.co/search?dataset=princeton-nlp/SWE-bench_Lite&config=default&split=test&query=${encodeURIComponent(INSTANCE)}`;
const body = await (await fetch(url)).json();
const row = (body.rows ?? []).map((r) => r.row).find((r) => r.instance_id === INSTANCE);
if (!row) {
  console.error(`인스턴스 ${INSTANCE} 행을 못 찾음`);
  process.exit(2);
}
const failToPass = JSON.parse(row.FAIL_TO_PASS ?? "[]");
const image = sweBenchImage(INSTANCE);
console.log(`인스턴스: ${INSTANCE}`);
console.log(`이미지: ${image}`);
console.log(
  `gold patch=${(row.patch ?? "").length}B  test_patch=${(row.test_patch ?? "").length}B  FAIL_TO_PASS=${failToPass.length}`,
);

const driver = new DockerDriver();

async function probePython(c) {
  // SWE-bench 이미지의 testbed conda env 탐지(sh -c 는 비로그인 → bashrc 미소스).
  const candidates = [
    ". /opt/miniconda3/etc/profile.d/conda.sh >/dev/null 2>&1 && conda activate testbed >/dev/null 2>&1 && python",
    "/opt/miniconda3/envs/testbed/bin/python",
    "python",
  ];
  for (const py of candidates) {
    const r = await c.exec(`${py} -m pytest --version`, { cwd: "/testbed", timeoutSec: 60 });
    if (r.exitCode === 0) return py;
  }
  return "python";
}

async function gradeWith(applyGold) {
  const c = await driver.provision({ os: "linux", needs: ["shell"], image });
  try {
    const py = await probePython(c);
    if (applyGold) {
      await c.writeFile("/testbed/.gold.patch", row.patch);
      const a = await c.exec("git apply .gold.patch", { cwd: "/testbed", timeoutSec: 120 });
      if (a.exitCode !== 0) console.log(`  (gold patch 적용 경고: ${a.stderr.slice(0, 120)})`);
    }
    const grader = new SweBenchGrader({
      testPatch: row.test_patch,
      failToPass,
      passToPass: [], // 오프라인: 네트워크 의존 가능한 P2P 제외, F2P 로 판별
      testCmd: `${py} -m pytest -q --no-header`,
      cwd: "/testbed",
    });
    const score = await grader.grade({
      case: {
        id: INSTANCE,
        env: { kind: "repo", source: { path: "/testbed" } },
        task: row.problem_statement ?? "",
        graders: [],
        timeoutSec: 600,
        tags: [],
      },
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      compute: c,
    });
    return score;
  } finally {
    await c.dispose();
  }
}

try {
  console.log(`\n=== docker pull ${image} (수 GB, 최초 1회) ===`);
  // DockerDriver.provision 이 자동 pull 하지만, 진행/시간을 위해 명시 pull.
  const { execFileSync } = await import("node:child_process");
  execFileSync("docker", ["pull", image], { stdio: ["ignore", "ignore", "inherit"] });

  console.log("\n=== 실 인스턴스 채점 (실 prebuilt 이미지 + 실 pytest) ===");
  const noFix = await gradeWith(false);
  console.log(`[no fix]   resolved(F2P)=${noFix.pass}  ${String(noFix.detail).split("\n").slice(-1)[0]?.slice(0, 70)}`);
  const gold = await gradeWith(true);
  console.log(`[gold patch] resolved(F2P)=${gold.pass}  ${String(gold.detail).split("\n").slice(-1)[0]?.slice(0, 70)}`);

  const ok = noFix.pass === false && gold.pass === true;
  console.log(
    ok
      ? `\n✅ SLICE 68: 실 SWE-bench_Lite(${INSTANCE})를 실 공식 prebuilt 이미지(repo+실 deps)로 풀 실행 — gold patch 적용 시 FAIL_TO_PASS 통과(resolved), 미적용 시 실패(unresolved). 실 이미지·실 deps·실 pytest 로 SWE-bench 평가 파이프라인 검증 완료.`
      : `\n⚠️ 기대와 불일치 (no-fix=${noFix.pass}, gold=${gold.pass})`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  console.log("\n=== 정리: 이미지 삭제 + build cache prune ===");
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("docker", ["rmi", "-f", image], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });
  } catch {}
  execFileSync("df", ["-h", "/"], { stdio: "inherit" });
}
