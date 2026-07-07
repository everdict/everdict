// 라이브 e2e (멀티테넌트·실인증판): **alice 워크스페이스(acme)에 예약을 직접 등록 → 실제 Temporal 이 발사** → 스코어카드 → 확인.
// scheduled-pinch-temporal.mjs 의 acme/alice 변형 — in-memory·no-auth 대신 **실 Postgres + Keycloak(OIDC) + auth 필수** 로 구동.
// "pinch 를 돌린 그 하니스" = acme 에 이미 등록된 codex 하니스 + pinch-dashboards 데이터셋(둘 다 acme 에 존재).
//
// 전제(외부 인프라 — 다른 live 스크립트가 nomad/k8s 를 전제하듯):
//   • Postgres @ localhost:5433 (everdict/everdict), acme 워크스페이스 데이터(codex 하니스 + pinch-dashboards) 존재.
//   • Keycloak @ KEYCLOAK_ISSUER, 사용자 alice/alice(workspace=acme, member), public client everdict-mcp(direct grants).
//   • Temporal dev server @ 127.0.0.1:7233.
//
// 구성(스크립트가 기동): 컨트롤플레인(:8793, Postgres+auth+Temporal) + everdict worker + alice 소유 self-hosted 러너(codex on PATH).
// 흐름: ① CP ② worker ③ alice 토큰(ROPC) → 러너 페어링+기동 ④ POST /schedules(as alice, cron "* * * * *",
//   pinch-dashboards×codex×self:<id>) → TemporalScheduleDriver 가 Schedule 생성 ⑤ Temporal 매분 발사 → 워크플로 →
//   internal fire → 스코어카드 submit(=alice 신원) → 러너가 codex 로 dashboard.json → tests-pass 채점
//   ⑥ 예약(acme 스코프)·발사·판정 확인 ⑦ 예약 삭제(Temporal Schedule 제거).
//
// 사용: node scripts/live/scheduled-pinch-acme-temporal.mjs  (apps/api/dist + apps/cli/dist 빌드, codex 로그인 필요).
import { spawn } from "node:child_process";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8793";
const BASE = `http://127.0.0.1:${PORT}`;
const TEMPORAL = process.env.EVERDICT_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const INTERNAL = "dev-internal-token";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://everdict:everdict@localhost:5433/everdict";
const KEYCLOAK_ISSUER = process.env.KEYCLOAK_ISSUER ?? "http://localhost:8081/realms/everdict";
const SECRETS_KEY = process.env.EVERDICT_SECRETS_KEY ?? "JIMYnR3k6zSSI7juJhzVQrhgpjnWXeCfBvakUMV2bQY=";
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// alice 액세스 토큰(ROPC, public client). 짧은 수명이므로 매 요청마다 새로 받는다.
async function aliceToken() {
  const r = await fetch(`${KEYCLOAK_ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "everdict-mcp",
      username: "alice",
      password: "alice",
      scope: "openid",
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`alice 토큰 실패: ${JSON.stringify(j)}`);
  return j.access_token;
}
const authH = async () => ({ "content-type": "application/json", authorization: `Bearer ${await aliceToken()}` });
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: await authH(), body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const del = async (p) => (await fetch(`${BASE}${p}`, { method: "DELETE", headers: await authH() })).status;
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: await authH() })).json();

const cpEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  PORT,
  DATABASE_URL,
  KEYCLOAK_ISSUER,
  EVERDICT_REQUIRE_AUTH: "1",
  EVERDICT_INTERNAL_TOKEN: INTERNAL,
  EVERDICT_SECRETS_KEY: SECRETS_KEY,
  EVERDICT_TEMPORAL_ADDRESS: TEMPORAL,
};

console.log(`=== ① 컨트롤플레인 기동 (:${PORT}, Postgres+auth+temporal=${TEMPORAL}) ===`);
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
      up =
        (await fetch(`${BASE}/health`).catch(() => ({ status: 0 }))).status === 200 || (await fetch(BASE)).status < 500;
    } catch {}
  }
  // /me 로 인증까지 확인
  const me = await get("/me");
  console.log(
    `  → 인증됨: subject=${me.subject} workspace=${me.workspace} roles=${JSON.stringify(me.roles)} via=${me.via}`,
  );
  if (me.workspace !== "acme") throw new Error(`alice 워크스페이스가 acme 가 아님: ${me.workspace}`);

  // ② worker
  console.log(`\n=== ② everdict worker 기동 (temporal=${TEMPORAL}, API 브리지=${BASE}) ===`);
  worker = spawn("node", ["apps/cli/dist/main.js", "worker", "--temporal-address", TEMPORAL], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, EVERDICT_API_URL: BASE, EVERDICT_INTERNAL_TOKEN: INTERNAL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stderr.on("data", (d) => process.stderr.write(`  [worker] ${d}`));
  worker.stdout.on("data", (d) => process.stdout.write(`  [worker] ${d}`));
  await sleep(3000);

  // ③ alice 소유 self-hosted 러너 페어링 + 기동 (codex on PATH)
  console.log("\n=== ③ POST /runners (as alice) + everdict runner --pair (codex on PATH) ===");
  const paired = await post("/runners", { label: "alice-codex-laptop", capabilities: ["repo"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error(`페어링 실패: ${JSON.stringify(paired.json)}`);
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  // ④ 예약 등록 (as alice) — acme 에 이미 있는 codex × pinch-dashboards. cron 매분.
  console.log(`\n=== ④ POST /schedules (as alice, cron "* * * * *", pinch-dashboards × codex × self:${runnerId}) ===`);
  const created = await post("/schedules", {
    name: "alice pinch nightly (codex)",
    cron: "* * * * *",
    runTemplate: {
      dataset: { id: "pinch-dashboards", version: "1.0.0" },
      // codex@1.0.0 = 번들 원본 command(작업 디렉터리에 dashboard.json 작성). acme 의 codex@2.0.0 는 stdout 을
      // `.grader/agent_stdout.txt` 로 리다이렉트하는 실험 변형이라 파일을 안 쓴다 → 예약과 무관한 하니스 버전 차이.
      harness: { id: "codex", version: "1.0.0" },
      runtime: `self:${runnerId}`,
    },
  });
  scheduleId = created.json.id;
  console.log(
    `  → ${created.status} scheduleId=${scheduleId} tenant=${created.json.tenant} createdBy=${created.json.createdBy}`,
  );
  if (!scheduleId) throw new Error(`예약 등록 실패: ${JSON.stringify(created.json)}`);

  // 워크스페이스 스코프 확인 — alice 의 /schedules 목록에 뜬다.
  const listed = await get("/schedules");
  const arr = Array.isArray(listed) ? listed : (listed.items ?? []);
  console.log(`  acme /schedules 목록: ${arr.map((s) => `${s.name}(${s.id.slice(0, 8)})`).join(", ")}`);

  // ⑤ Temporal 발사 대기 — 예약 레코드에 lastScorecardId 채워질 때까지.
  console.log("\n=== ⑤ Temporal 발사 대기 (매분 top; 워크플로→internal fire→스코어카드 submit) ===");
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

  // ⑥ 발사된 스코어카드 종료까지 폴링
  console.log("\n=== ⑥ 발사된 스코어카드 폴링 (codex 가 alice 러너에서 dashboard.json 작성 중…) ===");
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
  console.log(`  provenance: ${JSON.stringify(prov)}`); // ranOn=self-hosted, by=alice sub
  console.log(`  tests_pass: ${tp ? (tp.pass ? "PASS" : "FAIL") : "(없음)"}`);
  console.log(`  models: ${JSON.stringify(rec.models)}`);

  // finalize(워크플로가 poll-to-terminal 후 30s 주기로 호출) 가 예약 레코드에 최종 status 를 기록할 때까지 대기.
  console.log("\n  finalize 대기 (워크플로 30s 폴링 → lastStatus 종료 상태 기록)…");
  let schedFinal = sched;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    schedFinal = await get(`/schedules/${scheduleId}`);
    if (schedFinal.lastStatus === "succeeded" || schedFinal.lastStatus === "failed") break;
  }
  console.log(`  예약 최종: lastStatus=${schedFinal.lastStatus} lastFiredAt=${schedFinal.lastFiredAt}`);

  ok = rec.status === "succeeded" && prov?.ranOn === "self-hosted" && !!tp?.pass;
  console.log(
    ok
      ? "\n✅ alice 워크스페이스(acme) 예약 → 실제 Temporal 발사 → self-hosted codex 가 pinch 수행 → tests_pass PASS. 멀티테넌트 예약 실동작."
      : "\n⚠️ 기대와 불일치(위 로그 참고).",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  if (scheduleId) {
    try {
      const s = await del(`/schedules/${scheduleId}`);
      console.log(`\n=== ⑦ DELETE /schedules/${scheduleId} → ${s} (Temporal Schedule 제거) ===`);
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
