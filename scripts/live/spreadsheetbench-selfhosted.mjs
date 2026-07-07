// 라이브 e2e: **SpreadsheetBench(v1+v2) 샘플을 self-hosted 러너에서 codex 로 수행 → 채점**.
// spreadsheetbench 번들(examples/bundles/spreadsheetbench)을 적용하고, 자기완결 xlsx 샘플 2개(v1/v2)를 실제 codex 로 돌린다.
// codex-pinch-selfhosted.mjs 와 동형 — 하니스/벤치마크만 SpreadsheetBench 로 교체.
//   ① dev 컨트롤플레인(in-memory, no-auth) ② POST /runners 페어링 ③ everdict runner --pair(codex on PATH)
//   ④ POST /bundles/apply(spreadsheetbench) ⑤ 각 샘플 데이터셋 × codex × self:<id> 실행 ⑥ 폴링 → tests_pass 판정.
// 샘플은 setup 에서 openpyxl 을 설치하고 입력 xlsx 를 생성 → codex 가 output.xlsx 작성 → grader 가 셀 비교.
// 사용: node scripts/live/spreadsheetbench-selfhosted.mjs (apps/api/dist + apps/cli/dist 빌드, codex 로그인 필요)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8795";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
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

console.log(`=== ① 컨트롤플레인 기동 (dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
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

  console.log("\n=== ② POST /runners (이 머신 페어링) ===");
  const paired = await post("/runners", { label: "sbench-laptop", capabilities: ["repo"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error("페어링 실패");

  console.log("\n=== ③ everdict runner --pair (codex on PATH) ===");
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  console.log("\n=== ④ POST /bundles/apply (spreadsheetbench) ===");
  const inst = await post("/bundles/apply", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  const samples = [
    { dataset: "spreadsheetbench-v1-sample", label: "v1(합계→D1)" },
    { dataset: "spreadsheetbench-v2-sample", label: "v2(Profit열+총계, 원본보존)" },
  ];
  const outcomes = [];
  for (const s of samples) {
    console.log(`\n=== ⑤ POST /scorecards (${s.dataset} × codex × self:${runnerId}) — ${s.label} ===`);
    const run = await post("/scorecards", {
      dataset: { id: s.dataset, version: "1.0.0" },
      harness: { id: "codex" },
      runtime: `self:${runnerId}`,
    });
    const scId = run.json.id;
    console.log(`  → ${run.status} id=${scId ?? "-"}`);
    if (!scId) {
      console.log(`  ⚠️ 제출 실패: ${JSON.stringify(run.json)}`);
      outcomes.push(false);
      continue;
    }
    let rec;
    for (let i = 0; i < 240; i++) {
      await sleep(2000);
      rec = await get(`/scorecards/${scId}`);
      process.stdout.write(`  status=${rec.status}\r`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    const c = rec.scorecard?.results?.[0];
    const prov = c?.provenance;
    const tp = c?.scores?.find((x) => x.metric === "tests_pass");
    console.log(
      `\n  최종 status=${rec.status} · ranOn=${prov?.ranOn ?? "-"} · tests_pass=${tp ? (tp.pass ? "PASS" : "FAIL") : "(없음)"}`,
    );
    if (tp && !tp.pass && typeof tp.detail === "string") console.log(`    detail: ${tp.detail.slice(0, 300)}`);
    outcomes.push(rec.status === "succeeded" && !!tp?.pass);
  }

  ok = outcomes.every(Boolean) && outcomes.length === samples.length;
  console.log(
    ok
      ? "\n✅ SpreadsheetBench v1+v2 샘플 모두 self-hosted codex 로 수행 → tests_pass PASS. 번들 등록·실행 검증 완료."
      : `\n⚠️ 일부 샘플 불일치: ${JSON.stringify(outcomes)} (위 로그 참고).`,
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
