// 라이브 e2e: **codex-in-image 하니스로 SpreadsheetBench 수행**. codex 가 이미지(spreadsheetbench-codex:v1) 안에서
// 머신 ChatGPT 로그인(러너가 ~/.codex 를 마운트, own-pays)으로 풀고, 수식 산출을 이미지 안 LibreOffice 로 recalc 후 채점.
// 포터블 하니스(portable-harness-runtime) slice 1(러너 case.image→로컬 Docker) + 마운트(codex 로그인)를 실증.
//   ① dev 컨트롤플레인(in-memory) ② POST /runners ③ assay runner --pair --mount-codex-login (codex on PATH)
//   ④ POST /bundles/apply(spreadsheetbench: sbench-codex 하니스 + codex 샘플) ⑤ 샘플 × sbench-codex × self:<id> ⑥ tests_pass.
// 전제: docker + `docker build -t spreadsheetbench-codex:v1 -f examples/bundles/spreadsheetbench/Dockerfile.codex ...`,
//       머신 codex 로그인(~/.codex), apps/api/dist + apps/cli/dist 빌드.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8804";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-assay-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();
const bundle = JSON.parse(
  readFileSync(new URL("../../examples/bundles/spreadsheetbench/bundle.json", import.meta.url)),
);

const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, ASSAY_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
let runner;
let ok = false;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane 기동 실패");

  console.log("\n=== ② POST /runners ===");
  const paired = await post("/runners", { label: "codex-image", capabilities: ["repo"] });
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!paired.json.token || !runnerId) throw new Error("페어링 실패");

  console.log("\n=== ③ assay runner --pair --mount-codex-login (codex on PATH) ===");
  runner = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      paired.json.token,
      "--api-url",
      BASE,
      "--poll-interval-ms",
      "1000",
      "--mount-codex-login",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  console.log("\n=== ④ POST /bundles/apply (spreadsheetbench: sbench-codex + codex 샘플) ===");
  const inst = await post("/bundles/apply", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  console.log(`\n=== ⑤ POST /scorecards (codex 샘플 × sbench-codex × self:${runnerId}) ===`);
  const run = await post("/scorecards", {
    dataset: { id: "spreadsheetbench-v1-codex-sample", version: "1.0.0" },
    harness: { id: "sbench-codex", version: "1.0.0" },
    runtime: `self:${runnerId}`,
  });
  const scId = run.json.id;
  console.log(`  → ${run.status} id=${scId ?? "-"}`);
  if (!scId) throw new Error(`제출 실패: ${JSON.stringify(run.json)}`);

  console.log("\n=== ⑥ 폴링 (codex 가 이미지 안에서 머신 로그인으로 풀고 recalc 채점) ===");
  let rec;
  for (let i = 0; i < 200; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${scId}`);
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  const c = rec.scorecard?.results?.[0];
  const prov = c?.provenance;
  const tp = c?.scores?.find((s) => s.metric === "tests_pass");
  console.log(
    `\n  최종 status=${rec.status} · ranOn=${prov?.ranOn ?? "-"} · tests_pass=${tp ? (tp.pass ? "PASS" : "FAIL") : "(없음)"}`,
  );
  if (tp && !tp.pass && typeof tp.detail === "string") console.log(`    detail: ${tp.detail.slice(0, 300)}`);
  ok = rec.status === "succeeded" && !!tp?.pass;
  console.log(
    ok
      ? "\n✅ codex-in-image 하니스로 SpreadsheetBench 수행 → tests_pass PASS. 이미지 안 codex(머신 로그인 마운트) + LibreOffice recalc 채점."
      : "\n⚠️ 기대와 불일치(위 로그 참고 — codex 로그인/이미지/docker 확인).",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  try {
    runner?.kill("SIGKILL");
  } catch {}
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
