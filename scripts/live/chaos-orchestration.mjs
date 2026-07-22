// Chaos scenario suite — codifies the orchestration-resilience live drills as one repeatable script
// (docs/architecture/batch-resilience.md). Every scenario runs against a REAL control plane (own Postgres
// database, real Nomad) and injects a real fault, then asserts the recovery invariant:
//
//   ① CP SIGKILL mid-batch      → boot resume: finished results kept, only the remainder re-dispatched
//   ② CP SIGKILL mid-single-run → single-run durability: adopt the surviving job / re-dispatch from caseSpec
//   ③ dead runtime in the shard → spillover + circuit breaker + adaptive concurrency shrink, batch completes
//
// Isolation: a dedicated `everdict_chaos` database (dropped + recreated per run) so kill/restart cycles and
// boot recovery NEVER touch the dev control plane's records. Requires: Postgres (DATABASE_URL in
// apps/api/.env or env), Nomad dev at NOMAD_ADDR (default http://127.0.0.1:4646), built dist
// (pnpm build --filter @everdict/api).
//
// Usage: node scripts/live/chaos-orchestration.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";

const ROOT = new URL("../..", import.meta.url).pathname;
// pg lives in packages/db's dependency tree (pnpm — no root hoisting); borrow its resolution.
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const pg = require("pg");
const PORT = process.env.CP_PORT ?? "8931";
const BASE = `http://127.0.0.1:${PORT}`;
const INTERNAL = "chaos-internal-token";
const NOMAD = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const CHAOS_DB = "everdict_chaos";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let AK = "";
const H = () => ({ authorization: `Bearer ${AK}`, "content-type": "application/json" });
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};
const must = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};

// ---------- database (isolated, recreated per run) ----------
function devDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(`${ROOT}apps/api/.env`, "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL not found (env or apps/api/.env)");
  return m[1].trim();
}
function chaosDatabaseUrl(devUrl) {
  const u = new URL(devUrl);
  u.pathname = `/${CHAOS_DB}`;
  return u.toString();
}
async function recreateChaosDb(devUrl) {
  const client = new pg.Client({ connectionString: devUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${CHAOS_DB} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${CHAOS_DB}`);
  await client.end();
}

// ---------- control plane lifecycle (the thing we kill) ----------
let cp;
let cpLog = "";
function startCp(dbUrl) {
  cpLog = "";
  cp = spawn("node", ["apps/api/dist/main.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT,
      DATABASE_URL: dbUrl,
      NOMAD_ADDR: undefined, // runtimes are registered per-tenant below — no ambient global backend
      EVERDICT_INTERNAL_TOKEN: INTERNAL,
      EVERDICT_TEMPORAL_ADDRESS: undefined, // chaos drills target the in-process driver (boot recovery path)
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cp.stdout.on("data", (d) => {
    cpLog += String(d);
  });
  cp.stderr.on("data", (d) => {
    cpLog += String(d);
  });
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      if ((await fetch(`${BASE}/metrics`)).status === 200) return;
    } catch {}
  }
  throw new Error(`control plane did not come up:\n${cpLog.slice(-2000)}`);
}
function sigkillCp() {
  const pid = cp.pid;
  cp.kill("SIGKILL");
  console.log(`  💥 SIGKILL control plane (pid ${pid})`);
}

// ---------- fixtures ----------
async function registerFixtures() {
  const key = await fetch(`${BASE}/internal/tenant-keys`, {
    method: "POST",
    headers: { "x-internal-token": INTERNAL, "content-type": "application/json" },
    body: JSON.stringify({ workspace: "chaos" }),
  });
  AK = (await key.json()).apiKey;

  let r = await api("POST", "/runtimes", {
    kind: "nomad",
    id: "nomad-live",
    version: "1.0.0",
    addr: NOMAD,
    image: process.env.AGENT_IMAGE ?? "everdict-job-runner:slim",
  });
  must(r.status < 300, `runtime nomad-live registered (${r.status})`);
  r = await api("POST", "/runtimes", {
    kind: "nomad",
    id: "nomad-dead",
    version: "1.0.0",
    addr: "http://127.0.0.1:4747", // nothing listens here — the dead shard
    image: "everdict-job-runner:slim",
  });
  must(r.status < 300, `runtime nomad-dead registered (${r.status})`);

  r = await api("POST", "/harness-templates", {
    kind: "command",
    category: "cli-agent",
    id: "chaosbot",
    version: "1",
    setup: [],
    command: "sleep 6 && echo done {{task}}",
    env: {},
    params: {},
    trace: { kind: "none" },
  });
  must(r.status < 300, `harness template registered (${r.status})`);
  r = await api("POST", "/harnesses", {
    id: "chaosbot",
    version: "1.0.0",
    template: { id: "chaosbot", version: "1" },
    pins: {},
  });
  must(r.status < 300, `harness instance registered (${r.status})`);

  const cases = (n, prefix) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i}`,
      env: { kind: "repo", source: { files: {} } },
      task: `${prefix}-${i}`,
      graders: [{ id: "steps", kind: "steps", max: 100 }],
      timeoutSec: 300,
      tags: [],
    }));
  r = await api("POST", "/datasets", { id: "chaos-batch", version: "1.0.0", cases: cases(6, "b"), tags: [] });
  must(r.status < 300, `dataset chaos-batch registered (${r.status})`);
  r = await api("POST", "/datasets", { id: "chaos-shard", version: "1.0.0", cases: cases(12, "s"), tags: [] });
  must(r.status < 300, `dataset chaos-shard registered (${r.status})`);
}

// Completed-case steps ("<caseId> → PASS|FAIL|no result") — kill-window trigger. Verdict text doesn't matter,
// only that results exist to be KEPT across the restart.
const doneCount = (detail) =>
  (detail.steps ?? []).filter((s) => s.phase === "case" && / → (PASS|FAIL|no result)/.test(s.message)).length;

async function waitTerminalScorecard(id, timeoutS = 240) {
  for (let i = 0; i < timeoutS; i++) {
    const { json } = await api("GET", `/scorecards/${id}`);
    if (json.status && json.status !== "queued" && json.status !== "running") return json;
    await sleep(1000);
  }
  throw new Error(`scorecard ${id} not terminal after ${timeoutS}s`);
}

// ---------- scenarios ----------
async function scenario1BatchResume(dbUrl) {
  console.log("\n=== ① CP SIGKILL mid-batch → boot resume (finished results kept) ===");
  const { json: sc } = await api("POST", "/scorecards", {
    dataset: { id: "chaos-batch", version: "latest" },
    harness: { id: "chaosbot", version: "1.0.0" },
    runtime: "nomad-live",
    concurrency: 2, // 6 cases in 3 waves — a mid-batch kill reliably leaves both finished AND unfinished work
  });
  must(sc.id, `batch submitted (${sc.id})`);

  // Kill once at least 2 cases finished but the batch is still running.
  for (let i = 0; i < 120; i++) {
    const { json } = await api("GET", `/scorecards/${sc.id}`);
    if (json.status !== "queued" && json.status !== "running")
      throw new Error(`batch finished before the kill window (${json.status}) — enlarge the dataset`);
    if (doneCount(json) >= 2 && json.status === "running") break;
    await sleep(1000);
  }
  sigkillCp();
  await sleep(1000);

  startCp(dbUrl);
  await waitUp();
  must(/batches resumed 1/.test(cpLog), "boot log reports the batch resumed (not tombstoned)");

  const done = await waitTerminalScorecard(sc.id);
  must(done.status === "succeeded", `batch completed after restart (${done.status})`);
  must(done.scorecard.results.length === 6, `all 6 case results present (${done.scorecard.results.length})`);
  const resumeStep = (done.steps ?? []).find((s) => s.message.includes("Resumed after a control-plane restart"));
  must(resumeStep !== undefined, `resume step recorded: "${resumeStep?.message}"`);
  must(/finished case\(s\) kept/.test(resumeStep.message), "finished results were carried, not re-run");
}

async function scenario2SingleRunDurability(dbUrl) {
  console.log("\n=== ② CP SIGKILL mid-single-run → adopt / re-dispatch from caseSpec ===");
  const { json: run } = await api("POST", "/runs", {
    harness: { id: "chaosbot", version: "1.0.0" },
    runtime: "nomad-live",
    case: {
      id: "solo-chaos",
      env: { kind: "repo", source: { files: {} } },
      task: "solo",
      graders: [{ id: "steps", kind: "steps", max: 100 }],
      timeoutSec: 300,
      tags: [],
    },
  });
  must(run.id, `run submitted (${run.id})`);
  must(run.caseSpec?.placement?.target === "nomad-live", "caseSpec persisted with placement baked in (mig 0051)");

  await sleep(5000); // give the Nomad job time to exist
  sigkillCp();
  await sleep(1000);

  startCp(dbUrl);
  await waitUp();
  must(/runs resumed 1/.test(cpLog), "boot log reports the run resumed (adopt or caseSpec re-dispatch)");
  for (let i = 0; i < 120; i++) {
    const { json } = await api("GET", `/runs/${run.id}`);
    if (json.status === "succeeded") {
      must(true, "run settled succeeded after restart");
      return;
    }
    if (json.status === "failed") throw new Error(`run failed after restart: ${JSON.stringify(json.error)}`);
    await sleep(1000);
  }
  throw new Error("run not terminal after restart");
}

async function scenario3DeadRuntimeSpillover() {
  console.log("\n=== ③ dead shard runtime → spillover + breaker + adaptive shrink, batch completes ===");
  const { json: sc } = await api("POST", "/scorecards", {
    dataset: { id: "chaos-shard", version: "latest" },
    harness: { id: "chaosbot", version: "1.0.0" },
    runtime: "nomad-dead,nomad-live",
    concurrency: 4,
  });
  must(sc.id, `sharded batch submitted (${sc.id})`);
  const done = await waitTerminalScorecard(sc.id);
  must(done.status === "succeeded", `batch completed despite the dead shard (${done.status})`);
  must(done.scorecard.results.length === 12, `all 12 case results present (${done.scorecard.results.length})`);
  const msgs = (done.steps ?? []).map((s) => s.message);
  must(
    msgs.some((m) => m.includes("runtime spillover nomad-dead → nomad-live")),
    "spillover step recorded (dead → live)",
  );
  must(
    msgs.some((m) => m.includes("concurrency shrunk")),
    "adaptive concurrency shrink recorded (open circuit)",
  );
}

// ---------- main ----------
async function main() {
  // Preflight: Nomad reachable + dist built.
  const nomadUp = await fetch(`${NOMAD}/v1/agent/self`).then(
    (r) => r.ok,
    () => false,
  );
  if (!nomadUp) throw new Error(`Nomad not reachable at ${NOMAD} — start a dev agent first`);

  const devUrl = devDatabaseUrl();
  console.log(`=== chaos db: recreate ${CHAOS_DB} (isolated from the dev control plane) ===`);
  await recreateChaosDb(devUrl);
  const dbUrl = chaosDatabaseUrl(devUrl);

  startCp(dbUrl);
  await waitUp();
  console.log(`=== control plane up on :${PORT} (db ${CHAOS_DB}) ===`);
  await registerFixtures();

  await scenario1BatchResume(dbUrl);
  await scenario2SingleRunDurability(dbUrl);
  await scenario3DeadRuntimeSpillover();

  console.log("\n=== ✅ ALL CHAOS SCENARIOS PASSED ===");
}

main()
  .then(() => {
    cp?.kill("SIGTERM");
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n=== ❌ CHAOS SUITE FAILED: ${err.message}`);
    console.error(cpLog.slice(-1500));
    cp?.kill("SIGTERM");
    process.exit(1);
  });
