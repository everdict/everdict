// 라이브 e2e: **self-hosted 러너에서 codex 로 pinch 수행 → 리더보드**. 실제 codex CLI(머신 ChatGPT 로그인)로 구동.
// 흐름(멀티테넌트 SaaS, HTTP API 만):
//   ① dev 컨트롤플레인 기동(in-memory, auth 미요구).
//   ② POST /runners : 이 머신을 러너로 페어링 → rnr_ 토큰.
//   ③ assay runner --pair : 러너 프로세스 기동(codex 가 PATH 에 있어야 함 — LocalDriver 인프로세스 실행).
//   ④ POST /bundles/install : codex 하니스 + pinch 벤치마크 번들 원샷 설치.
//   ⑤ POST /scorecards {dataset: pinch-dashboards, harness: codex, runtime: self:<id>} : self-hosted 로 실행.
//   ⑥ 폴링 → provenance(ranOn=self-hosted) + 케이스 판정 + GET /scorecards/leaderboard 행 출력.
// codex 는 워크스페이스 예산을 차감하지 않는다(머신 로그인이 결제).
//
// 사용: node scripts/live/codex-pinch-selfhosted.mjs   (apps/api/dist + apps/cli/dist 빌드 필요; codex 로그인 필요)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8790";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-assay-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();

const bundle = JSON.parse(readFileSync(new URL("../../examples/bundles/codex-pinch/bundle.json", import.meta.url)));

console.log(`=== ① 컨트롤플레인 기동 (dev, :${PORT}) ===`);
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

  // ② 러너 페어링
  console.log("\n=== ② POST /runners (이 머신 페어링) ===");
  const paired = await post("/runners", { label: "codex-laptop", capabilities: ["repo"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error("페어링 실패");

  // ③ 러너 프로세스 기동 — codex 가 PATH 에 있어야(LocalDriver 인프로세스). runner 소유자=dev(scorecard 제출자와 동일).
  console.log("\n=== ③ assay runner --pair (codex on PATH) ===");
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000); // 러너 MCP 세션 연결 대기

  // ④ 번들 설치(codex + pinch)
  console.log("\n=== ④ POST /bundles/install (codex + pinch) ===");
  const inst = await post("/bundles/install", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  // ⑤ pinch-dashboards 를 codex × self-hosted 로 실행
  console.log(`\n=== ⑤ POST /scorecards (pinch-dashboards × codex × self:${runnerId}) ===`);
  const run = await post("/scorecards", {
    dataset: { id: "pinch-dashboards", version: "1.0.0" },
    harness: { id: "codex" },
    runtime: `self:${runnerId}`,
  });
  console.log(`  → ${run.status} id=${run.json.id ?? "-"}`);
  const scId = run.json.id;
  if (!scId) throw new Error(`scorecard 제출 실패: ${JSON.stringify(run.json)}`);

  // ⑥ 폴링(codex 실행 ~1-2분) → 결과
  console.log("\n=== ⑥ 폴링 (codex 가 self-hosted 러너에서 dashboard.json 작성 중…) ===");
  let rec;
  for (let i = 0; i < 200; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${scId}`);
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  최종 status=${rec.status}`);
  const c = rec.scorecard?.results?.[0];
  const prov = c?.provenance;
  const tp = c?.scores?.find((s) => s.metric === "tests_pass");
  console.log(`  provenance: ${JSON.stringify(prov)}`); // ranOn=self-hosted 기대
  console.log(`  tests_pass: ${tp ? (tp.pass ? "PASS" : "FAIL") : "(없음)"}`);
  console.log(`  models: ${JSON.stringify(rec.models)}`); // 선언 gpt-5-codex

  const lb = await get("/scorecards/leaderboard?dataset=pinch-dashboards&metric=tests_pass");
  console.log("\n=== 리더보드 (pinch-dashboards × harness×model) ===");
  for (const row of lb.rows ?? [])
    console.log(
      `  #${row.rank} ${row.harness.id}@${row.harness.version} × ${row.model ?? "unknown"} — score=${row.score ?? "–"} (runs=${row.runs})`,
    );

  ok = rec.status === "succeeded" && prov?.ranOn === "self-hosted" && (lb.rows ?? []).length > 0;
  console.log(
    ok
      ? "\n✅ self-hosted 러너에서 codex 가 pinch 수행 → 리더보드. 머신 codex 로그인이 결제(워크스페이스 예산 미차감)."
      : "\n⚠️ 기대와 불일치(위 로그 참고). codex 로그인/PATH 또는 python3 확인.",
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
