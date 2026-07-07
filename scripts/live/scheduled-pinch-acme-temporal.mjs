// Live e2e (multi-tenant, real-auth variant): **register a schedule directly in alice's workspace (acme) → real Temporal fires it** → scorecard → verify.
// The acme/alice variant of scheduled-pinch-temporal.mjs — runs on **real Postgres + Keycloak (OIDC) + auth required** instead of in-memory/no-auth.
// "the harness that ran pinch" = the codex harness already registered in acme + the pinch-dashboards dataset (both exist in acme).
//
// Assumptions (external infra — as other live scripts assume nomad/k8s):
//   • Postgres @ localhost:5433 (everdict/everdict), with acme workspace data (codex harness + pinch-dashboards) present.
//   • Keycloak @ KEYCLOAK_ISSUER, user alice/alice (workspace=acme, member), public client everdict-mcp (direct grants).
//   • Temporal dev server @ 127.0.0.1:7233.
//
// Setup (started by the script): control plane (:8793, Postgres+auth+Temporal) + everdict worker + alice-owned self-hosted runner (codex on PATH).
// Flow: ① CP ② worker ③ alice token (ROPC) → pair + start runner ④ POST /schedules (as alice, cron "* * * * *",
//   pinch-dashboards×codex×self:<id>) → TemporalScheduleDriver creates the Schedule ⑤ Temporal fires every minute → workflow →
//   internal fire → scorecard submit (= alice's identity) → runner produces dashboard.json via codex → tests-pass grading
//   ⑥ verify the schedule (acme-scoped), the fire, and the verdict ⑦ delete the schedule (removes the Temporal Schedule).
//
// Usage: node scripts/live/scheduled-pinch-acme-temporal.mjs  (build apps/api/dist + apps/cli/dist, codex login required).
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

// alice access token (ROPC, public client). Short-lived, so fetch a fresh one per request.
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
  if (!j.access_token) throw new Error(`alice token failed: ${JSON.stringify(j)}`);
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

console.log(`=== ① start control plane (:${PORT}, Postgres+auth+temporal=${TEMPORAL}) ===`);
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
  // verify auth via /me too
  const me = await get("/me");
  console.log(
    `  → authenticated: subject=${me.subject} workspace=${me.workspace} roles=${JSON.stringify(me.roles)} via=${me.via}`,
  );
  if (me.workspace !== "acme") throw new Error(`alice's workspace is not acme: ${me.workspace}`);

  // ② worker
  console.log(`\n=== ② start everdict worker (temporal=${TEMPORAL}, API bridge=${BASE}) ===`);
  worker = spawn("node", ["apps/cli/dist/main.js", "worker", "--temporal-address", TEMPORAL], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, EVERDICT_API_URL: BASE, EVERDICT_INTERNAL_TOKEN: INTERNAL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stderr.on("data", (d) => process.stderr.write(`  [worker] ${d}`));
  worker.stdout.on("data", (d) => process.stdout.write(`  [worker] ${d}`));
  await sleep(3000);

  // ③ pair + start alice-owned self-hosted runner (codex on PATH)
  console.log("\n=== ③ POST /runners (as alice) + everdict runner --pair (codex on PATH) ===");
  const paired = await post("/runners", { label: "alice-codex-laptop", capabilities: ["repo"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error(`pairing failed: ${JSON.stringify(paired.json)}`);
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  // ④ register the schedule (as alice) — codex × pinch-dashboards, both already in acme. cron every minute.
  console.log(`\n=== ④ POST /schedules (as alice, cron "* * * * *", pinch-dashboards × codex × self:${runnerId}) ===`);
  const created = await post("/schedules", {
    name: "alice pinch nightly (codex)",
    cron: "* * * * *",
    runTemplate: {
      dataset: { id: "pinch-dashboards", version: "1.0.0" },
      // codex@1.0.0 = the bundle's original command (writes dashboard.json to the work dir). acme's codex@2.0.0 is an
      // experimental variant that redirects stdout to `.grader/agent_stdout.txt` and doesn't write the file → a harness version difference unrelated to scheduling.
      harness: { id: "codex", version: "1.0.0" },
      runtime: `self:${runnerId}`,
    },
  });
  scheduleId = created.json.id;
  console.log(
    `  → ${created.status} scheduleId=${scheduleId} tenant=${created.json.tenant} createdBy=${created.json.createdBy}`,
  );
  if (!scheduleId) throw new Error(`schedule registration failed: ${JSON.stringify(created.json)}`);

  // Verify workspace scope — it shows up in alice's /schedules list.
  const listed = await get("/schedules");
  const arr = Array.isArray(listed) ? listed : (listed.items ?? []);
  console.log(`  acme /schedules list: ${arr.map((s) => `${s.name}(${s.id.slice(0, 8)})`).join(", ")}`);

  // ⑤ Wait for Temporal to fire — until the schedule record's lastScorecardId is set.
  console.log("\n=== ⑤ wait for Temporal fire (top of each minute; workflow→internal fire→scorecard submit) ===");
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

  // ⑥ poll the fired scorecard until it terminates
  console.log("\n=== ⑥ poll the fired scorecard (codex writing dashboard.json on alice's runner…) ===");
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
  console.log(`  provenance: ${JSON.stringify(prov)}`); // ranOn=self-hosted, by=alice sub
  console.log(`  tests_pass: ${tp ? (tp.pass ? "PASS" : "FAIL") : "(none)"}`);
  console.log(`  models: ${JSON.stringify(rec.models)}`);

  // Wait until finalize (the workflow calls it every 30s after poll-to-terminal) records the final status on the schedule record.
  console.log("\n  waiting for finalize (workflow 30s poll → records terminal lastStatus)…");
  let schedFinal = sched;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    schedFinal = await get(`/schedules/${scheduleId}`);
    if (schedFinal.lastStatus === "succeeded" || schedFinal.lastStatus === "failed") break;
  }
  console.log(`  schedule final: lastStatus=${schedFinal.lastStatus} lastFiredAt=${schedFinal.lastFiredAt}`);

  ok = rec.status === "succeeded" && prov?.ranOn === "self-hosted" && !!tp?.pass;
  console.log(
    ok
      ? "\n✅ alice's workspace (acme) schedule → real Temporal fire → self-hosted codex runs pinch → tests_pass PASS. Multi-tenant scheduling works for real."
      : "\n⚠️ does not match expectations (see logs above).",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  if (scheduleId) {
    try {
      const s = await del(`/schedules/${scheduleId}`);
      console.log(`\n=== ⑦ DELETE /schedules/${scheduleId} → ${s} (removes the Temporal Schedule) ===`);
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
