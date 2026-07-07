// 라이브 e2e: **pinch 를 돌린 그 하니스(codex)를 Everdict 예약(cron)으로 등록 → 실제 Temporal 이 발사** → 스코어카드 → 리더보드.
// scheduled-evals 설계문(docs/architecture/scheduled-evals.md)의 "live Temporal e2e" 후속을 실증한다.
//
// 구성(모두 로컬):
//   • Temporal dev server (docker; 이 스크립트 밖에서 기동, 127.0.0.1:7233) — cron 엔진.
//   • 컨트롤플레인(node, in-memory, no-auth) — EVERDICT_TEMPORAL_ADDRESS 로 예약을 Temporal Schedule 로 동기화 +
//     self-hosted lease 허브로 codex 케이스 실행. EVERDICT_INTERNAL_TOKEN 으로 internal 발사 라우트 가드.
//   • everdict worker(node) — scheduledScorecardWorkflow 실행(fire/poll/finalize 를 internal 라우트로 브리지).
//   • everdict runner(node, codex on PATH) — 페어링된 self-hosted 러너. 발사된 스코어카드의 codex 케이스를 로컬 실행.
//
// 흐름:
//   ① CP 기동 → ② worker 기동 → ③ 러너 페어링+기동 → ④ codex+pinch 번들 적용
//   → ⑤ POST /schedules {cron:"* * * * *", pinch-dashboards × codex × self:<id>}  (→ TemporalScheduleDriver 가 Schedule 생성)
//   → ⑥ Temporal 이 매분 발사 → 워크플로 → internal fire → 스코어카드 submit → 러너가 codex 로 dashboard.json → tests-pass 채점
//   → ⑦ 예약 레코드(lastFiredAt/lastScorecardId/lastStatus) + 스코어카드 판정 + 리더보드 확인 → ⑧ 예약 삭제(Temporal Schedule 제거).
//
// 사용: docker 로 Temporal 기동 후 `node scripts/live/scheduled-pinch-temporal.mjs` (apps/api/dist + apps/cli/dist 빌드, codex 로그인 필요).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8791";
const BASE = `http://127.0.0.1:${PORT}`;
const TEMPORAL = process.env.EVERDICT_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const INTERNAL = "dev-internal-token";
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const del = async (p) => {
  const r = await fetch(`${BASE}${p}`, { method: "DELETE", headers: H });
  return { status: r.status };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();

const bundle = JSON.parse(readFileSync(new URL("../../examples/bundles/codex-pinch/bundle.json", import.meta.url)));

const cpEnv = {
  ...process.env,
  PORT,
  EVERDICT_REQUIRE_AUTH: "",
  KEYCLOAK_ISSUER: "",
  DATABASE_URL: "",
  EVERDICT_TEMPORAL_ADDRESS: TEMPORAL, // ← 예약을 Temporal Schedule 로 동기화(발사 활성)
  EVERDICT_INTERNAL_TOKEN: INTERNAL,
};

console.log(`=== ① 컨트롤플레인 기동 (dev, :${PORT}, temporal=${TEMPORAL}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], { cwd: ROOT, env: cpEnv, stdio: ["ignore", "pipe", "pipe"] });
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));

let worker;
let runner;
let ok = false;
let scheduleId;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane 기동 실패");

  // ② worker — scheduledScorecardWorkflow 실행 + internal 라우트로 브리지
  console.log(`\n=== ② everdict worker 기동 (temporal=${TEMPORAL}, API 브리지=${BASE}) ===`);
  worker = spawn("node", ["apps/cli/dist/main.js", "worker", "--temporal-address", TEMPORAL], {
    cwd: ROOT,
    env: { ...process.env, EVERDICT_API_URL: BASE, EVERDICT_INTERNAL_TOKEN: INTERNAL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stderr.on("data", (d) => process.stderr.write(`  [worker] ${d}`));
  worker.stdout.on("data", (d) => process.stdout.write(`  [worker] ${d}`));
  await sleep(3000);

  // ③ 러너 페어링 + 기동 (codex on PATH — pinch 를 돌린 그 하니스)
  console.log("\n=== ③ POST /runners + everdict runner --pair (codex on PATH) ===");
  const paired = await post("/runners", { label: "codex-laptop", capabilities: ["repo"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error("페어링 실패");
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  // ④ 번들 적용(codex + pinch)
  console.log("\n=== ④ POST /bundles/apply (codex + pinch) ===");
  const inst = await post("/bundles/apply", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  // ⑤ 예약 등록 — pinch 를 돌린 그 하니스(codex)를 그대로. cron 매분(데모: 곧 발사되도록).
  console.log(`\n=== ⑤ POST /schedules (cron "* * * * *", pinch-dashboards × codex × self:${runnerId}) ===`);
  const created = await post("/schedules", {
    name: "pinch nightly (codex)",
    cron: "* * * * *",
    runTemplate: {
      dataset: { id: "pinch-dashboards", version: "1.0.0" },
      harness: { id: "codex" },
      runtime: `self:${runnerId}`,
    },
  });
  scheduleId = created.json.id;
  console.log(
    `  → ${created.status} scheduleId=${scheduleId} enabled=${created.json.enabled} cron=${created.json.cron}`,
  );
  if (!scheduleId) throw new Error(`예약 등록 실패: ${JSON.stringify(created.json)}`);

  // ⑥ Temporal 이 매분(top-of-minute) 발사 — 예약 레코드에 lastScorecardId 가 채워질 때까지 대기(=발사 성공 증거).
  console.log("\n=== ⑥ Temporal 발사 대기 (매분 top; 워크플로→internal fire→스코어카드 submit) ===");
  let sched;
  let firedScId;
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    sched = await get(`/schedules/${scheduleId}`);
    process.stdout.write(
      `  대기 ${i * 3}s — lastFiredAt=${sched.lastFiredAt ?? "-"} lastScorecardId=${sched.lastScorecardId ?? "-"}\r`,
    );
    if (sched.lastScorecardId) {
      firedScId = sched.lastScorecardId;
      break;
    }
  }
  console.log("");
  if (!firedScId) throw new Error("Temporal 이 예약을 발사하지 않음(lastScorecardId 미설정)");
  console.log(
    `  ✔ 발사됨! lastFiredAt=${sched.lastFiredAt} lastScorecardId=${firedScId} lastStatus=${sched.lastStatus}`,
  );

  // ⑦ 발사된 스코어카드 종료까지 폴링(codex ~1-2분) → 판정
  console.log("\n=== ⑦ 발사된 스코어카드 폴링 (codex 가 self-hosted 러너에서 dashboard.json 작성 중…) ===");
  let rec;
  for (let i = 0; i < 200; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${firedScId}`);
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  최종 status=${rec.status}`);
  const c = rec.scorecard?.results?.[0];
  const prov = c?.provenance;
  const tp = c?.scores?.find((s) => s.metric === "tests_pass");
  console.log(`  provenance: ${JSON.stringify(prov)}`); // ranOn=self-hosted 기대
  console.log(`  tests_pass: ${tp ? (tp.pass ? "PASS" : "FAIL") : "(없음)"}`);

  // 예약 레코드 최종 상태(finalize 가 lastStatus 를 종료 상태로 기록)
  const schedFinal = await get(`/schedules/${scheduleId}`);
  console.log(`\n  예약 최종: lastStatus=${schedFinal.lastStatus} lastFiredAt=${schedFinal.lastFiredAt}`);

  const lb = await get("/scorecards/leaderboard?dataset=pinch-dashboards&metric=tests_pass");
  console.log("\n=== 리더보드 (pinch-dashboards × harness×model) ===");
  for (const row of lb.rows ?? [])
    console.log(
      `  #${row.rank} ${row.harness.id}@${row.harness.version} × ${row.model ?? "unknown"} — score=${row.score ?? "–"} (runs=${row.runs})`,
    );

  ok = rec.status === "succeeded" && prov?.ranOn === "self-hosted" && !!tp?.pass && (lb.rows ?? []).length > 0;
  console.log(
    ok
      ? "\n✅ 예약(cron) → 실제 Temporal 발사 → self-hosted codex 가 pinch 수행 → tests_pass PASS → 리더보드. 예약이 실동작함."
      : "\n⚠️ 기대와 불일치(위 로그 참고).",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  // ⑧ 예약 삭제 → Temporal Schedule 제거(매분 재발사 중단)
  if (scheduleId) {
    try {
      const d = await del(`/schedules/${scheduleId}`);
      console.log(`\n=== ⑧ DELETE /schedules/${scheduleId} → ${d.status} (Temporal Schedule 제거) ===`);
    } catch {}
  }
  try {
    runner?.kill("SIGKILL");
  } catch {}
  try {
    worker?.kill("SIGKILL");
  } catch {}
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
