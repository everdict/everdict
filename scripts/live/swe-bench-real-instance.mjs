// Live e2e (SLICE 68): full run of one real SWE-bench_Lite instance with the real official prebuilt image.
// Image (repo@base_commit + real conda deps bundled) → DockerDriver container → SweBenchGrader with real test_patch + real pytest.
//   Inject the gold patch (the dataset's answer = placeholder for the agent prediction) → FAIL_TO_PASS passes → resolved.   Not applied → fails → unresolved.
// Offline sandbox, so PASS_TO_PASS (may depend on network) is excluded — FAIL_TO_PASS is the bug-fix signal.
import process from "node:process";
import { sweBenchImage } from "../../packages/datasets/dist/index.js";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { SweBenchGrader } from "../../packages/graders/dist/index.js";

const INSTANCE = process.env.SWE_INSTANCE ?? "psf__requests-3362";

// 1) Instance row (gold patch / test_patch / FAIL_TO_PASS) — HF datasets-server.
const url = `https://datasets-server.huggingface.co/search?dataset=princeton-nlp/SWE-bench_Lite&config=default&split=test&query=${encodeURIComponent(INSTANCE)}`;
const body = await (await fetch(url)).json();
const row = (body.rows ?? []).map((r) => r.row).find((r) => r.instance_id === INSTANCE);
if (!row) {
  console.error(`could not find row for instance ${INSTANCE}`);
  process.exit(2);
}
const failToPass = JSON.parse(row.FAIL_TO_PASS ?? "[]");
const image = sweBenchImage(INSTANCE);
console.log(`instance: ${INSTANCE}`);
console.log(`image: ${image}`);
console.log(
  `gold patch=${(row.patch ?? "").length}B  test_patch=${(row.test_patch ?? "").length}B  FAIL_TO_PASS=${failToPass.length}`,
);

const driver = new DockerDriver();

async function probePython(c) {
  // Detect the testbed conda env in the SWE-bench image (sh -c is non-login → bashrc not sourced).
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
      if (a.exitCode !== 0) console.log(`  (gold patch apply warning: ${a.stderr.slice(0, 120)})`);
    }
    const grader = new SweBenchGrader({
      testPatch: row.test_patch,
      failToPass,
      passToPass: [], // offline: exclude possibly network-dependent P2P, decide via F2P
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
  console.log(`\n=== docker pull ${image} (multiple GB, first time only) ===`);
  // DockerDriver.provision auto-pulls, but pull explicitly for progress/timing.
  const { execFileSync } = await import("node:child_process");
  execFileSync("docker", ["pull", image], { stdio: ["ignore", "ignore", "inherit"] });

  console.log("\n=== grade the real instance (real prebuilt image + real pytest) ===");
  const noFix = await gradeWith(false);
  console.log(`[no fix]   resolved(F2P)=${noFix.pass}  ${String(noFix.detail).split("\n").slice(-1)[0]?.slice(0, 70)}`);
  const gold = await gradeWith(true);
  console.log(`[gold patch] resolved(F2P)=${gold.pass}  ${String(gold.detail).split("\n").slice(-1)[0]?.slice(0, 70)}`);

  const ok = noFix.pass === false && gold.pass === true;
  console.log(
    ok
      ? `\n✅ SLICE 68: full run of real SWE-bench_Lite (${INSTANCE}) with the real official prebuilt image (repo + real deps) — gold patch applied → FAIL_TO_PASS passes (resolved), not applied → fails (unresolved). SWE-bench eval pipeline verified with a real image, real deps, real pytest.`
      : `\n⚠️ Mismatch vs expected (no-fix=${noFix.pass}, gold=${gold.pass})`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  console.log("\n=== cleanup: remove image + build cache prune ===");
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("docker", ["rmi", "-f", image], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });
  } catch {}
  execFileSync("df", ["-h", "/"], { stdio: "inherit" });
}
