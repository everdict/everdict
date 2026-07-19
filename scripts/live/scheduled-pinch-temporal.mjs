// Live e2e: **register the harness that ran pinch (codex) as an Everdict schedule (cron) → real Temporal fires it** → scorecard → leaderboard.
// Demonstrates the "live Temporal e2e" follow-up from the scheduled-evals design doc (docs/architecture/scheduled-evals.md).
//
// Setup (all local):
//   • Temporal dev server (docker; started outside this script, 127.0.0.1:7233) — the cron engine.
//   • control plane (node, in-memory, no-auth) — syncs the schedule to a Temporal Schedule via EVERDICT_TEMPORAL_ADDRESS +
//     runs codex cases as the self-hosted lease hub. EVERDICT_INTERNAL_TOKEN guards the internal fire route.
//   • everdict worker (node) — runs scheduledScorecardWorkflow (bridges fire/poll/finalize to internal routes).
//   • everdict runner (node, codex on PATH) — a paired self-hosted runner. Runs the fired scorecard's codex case locally.
//
// Flow:
//   ① start CP → ② start worker → ③ pair + start runner → ④ apply codex+pinch bundle
//   → ⑤ POST /schedules {cron:"* * * * *", pinch-dashboards × codex × self:<id>}  (→ TemporalScheduleDriver creates the Schedule)
//   → ⑥ Temporal fires every minute → workflow → internal fire → scorecard submit → runner produces dashboard.json via codex → tests-pass grading
//   → ⑦ verify the schedule record (lastFiredAt/lastScorecardId/lastStatus) + scorecard verdict + leaderboard → ⑧ delete the schedule (removes the Temporal Schedule).
//
// Usage: after starting Temporal via docker, `node scripts/live/scheduled-pinch-temporal.mjs` (build apps/api/dist + apps/cli/dist, codex login required).
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
  EVERDICT_TEMPORAL_ADDRESS: TEMPORAL, // ← sync the schedule to a Temporal Schedule (enables firing)
  EVERDICT_INTERNAL_TOKEN: INTERNAL,
};

console.log(`=== ① start control plane (dev, :${PORT}, temporal=${TEMPORAL}) ===`);
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
  if (!up) throw new Error("control plane failed to start");

  // ② worker — runs scheduledScorecardWorkflow + bridges to internal routes
  console.log(`\n=== ② start everdict worker (temporal=${TEMPORAL}, API bridge=${BASE}) ===`);
  worker = spawn("node", ["apps/cli/dist/main.js", "worker", "--temporal-address", TEMPORAL], {
    cwd: ROOT,
    env: { ...process.env, EVERDICT_API_URL: BASE, EVERDICT_INTERNAL_TOKEN: INTERNAL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stderr.on("data", (d) => process.stderr.write(`  [worker] ${d}`));
  worker.stdout.on("data", (d) => process.stdout.write(`  [worker] ${d}`));
  await sleep(3000);

  // ③ pair + start runner (codex on PATH — the harness that ran pinch)
  console.log("\n=== ③ POST /runners + everdict runner --pair (codex on PATH) ===");
  const paired = await post("/runners", { label: "codex-laptop", capabilities: ["git"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error("pairing failed");
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  // ④ apply the bundle (codex + pinch)
  console.log("\n=== ④ POST /bundles/apply (codex + pinch) ===");
  const inst = await post("/bundles/apply", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  // ⑤ register the schedule — reusing the harness that ran pinch (codex) as-is. cron every minute (demo: fires soon).
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
  if (!scheduleId) throw new Error(`schedule registration failed: ${JSON.stringify(created.json)}`);

  // ⑥ Temporal fires top-of-minute — wait until the schedule record's lastScorecardId is set (= proof of a successful fire).
  console.log("\n=== ⑥ wait for Temporal fire (top of each minute; workflow→internal fire→scorecard submit) ===");
  let sched;
  let firedScId;
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    sched = await get(`/schedules/${scheduleId}`);
    process.stdout.write(
      `  waited ${i * 3}s — lastFiredAt=${sched.lastFiredAt ?? "-"} lastScorecardId=${sched.lastScorecardId ?? "-"}\r`,
    );
    if (sched.lastScorecardId) {
      firedScId = sched.lastScorecardId;
      break;
    }
  }
  console.log("");
  if (!firedScId) throw new Error("Temporal did not fire the schedule (lastScorecardId not set)");
  console.log(
    `  ✔ fired! lastFiredAt=${sched.lastFiredAt} lastScorecardId=${firedScId} lastStatus=${sched.lastStatus}`,
  );

  // ⑦ poll the fired scorecard until it terminates (codex ~1-2 min) → verdict
  console.log("\n=== ⑦ poll the fired scorecard (codex writing dashboard.json on the self-hosted runner…) ===");
  let rec;
  for (let i = 0; i < 200; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${firedScId}`);
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  final status=${rec.status}`);
  const c = rec.scorecard?.results?.[0];
  const prov = c?.provenance;
  const tp = c?.scores?.find((s) => s.metric === "tests_pass");
  console.log(`  provenance: ${JSON.stringify(prov)}`); // expect ranOn=self-hosted
  console.log(`  tests_pass: ${tp ? (tp.pass ? "PASS" : "FAIL") : "(none)"}`);

  // Schedule record final state (finalize records lastStatus as the terminal state)
  const schedFinal = await get(`/schedules/${scheduleId}`);
  console.log(`\n  schedule final: lastStatus=${schedFinal.lastStatus} lastFiredAt=${schedFinal.lastFiredAt}`);

  const lb = await get("/scorecards/leaderboard?dataset=pinch-dashboards&metric=tests_pass");
  console.log("\n=== leaderboard (pinch-dashboards × harness×model) ===");
  for (const row of lb.rows ?? [])
    console.log(
      `  #${row.rank} ${row.harness.id}@${row.harness.version} × ${row.model ?? "unknown"} — score=${row.score ?? "–"} (runs=${row.runs})`,
    );

  ok = rec.status === "succeeded" && prov?.ranOn === "self-hosted" && !!tp?.pass && (lb.rows ?? []).length > 0;
  console.log(
    ok
      ? "\n✅ schedule (cron) → real Temporal fire → self-hosted codex runs pinch → tests_pass PASS → leaderboard. Scheduling works for real."
      : "\n⚠️ does not match expectations (see logs above).",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  // ⑧ delete the schedule → removes the Temporal Schedule (stops re-firing every minute)
  if (scheduleId) {
    try {
      const d = await del(`/schedules/${scheduleId}`);
      console.log(`\n=== ⑧ DELETE /schedules/${scheduleId} → ${d.status} (removes the Temporal Schedule) ===`);
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
