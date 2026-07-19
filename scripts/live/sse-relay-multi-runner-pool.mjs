// Live e2e: **EIGHT self-hosted runner PROCESSES run one topology scorecard 8-wide** (personal pool).
// The multi-process sequel to sse-relay-parallel-selfhosted.mjs (one process × 8 workers): here the 8
// concurrent cases land on 8 SEPARATE runner processes (1 worker each) via runtime:"self", which also
// exercises adopt-don't-kill for real — one runner deploys the warm topology (warmup batch), the other
// seven ADOPT it (same deterministic names) instead of rm -f'ing it out from under each other.
//
// Proves:
//   ① pool distribution — the 8 cases carry 8 DISTINCT provenance.runner ids (all self-hosted);
//   ② cross-process topology sharing — container IDs are identical before/after the 8-wide batch
//     (7 adopting processes never killed/redeployed the deployer's live topology);
//   ③ 8-wide parallelism — 8 concurrent browser sessions / SSE streams / agent runs at peak;
//   ④ isolation — every case's transcript complete (missing=0) and leak-free (leaked=0),
//     8 distinct browser sessions, per-case nonce sets disjoint.
//
// Usage: node scripts/live/sse-relay-multi-runner-pool.mjs   (docker + apps/api/dist + apps/cli/dist built)
//   KEEP=1 keeps the warm topology up for inspection after the run.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8794";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const HARNESS = "sse-relay-bench";
const VERSION = "1.0.0";
const NETWORK = `everdict-${HARNESS}-${VERSION}`;
const RUNNERS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

const topologyContainerIds = () =>
  sh("docker", ["ps", "--filter", `name=${NETWORK}`, "--format", "{{.ID}} {{.Names}}"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();

const serviceStats = async (container, port) => {
  const out = sh("docker", ["port", container, String(port)])
    .trim()
    .split("\n")[0];
  const hostPort = out.split(":").pop();
  return (await fetch(`http://127.0.0.1:${hostPort}/stats`)).json();
};

const maxOverlap = (runs) => {
  const events = [];
  for (const r of runs) {
    if (r.started_ms == null || r.finished_ms == null) continue;
    events.push([r.started_ms, 1], [r.finished_ms, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, d] of events) {
    now += d;
    peak = Math.max(peak, now);
  }
  return peak;
};

const runScorecard = async (label, body, pollMinutes) => {
  console.log(`\n=== POST /scorecards (${label}) ===`);
  const run = await post("/scorecards", body);
  const id = run.json.id;
  if (!id) throw new Error(`scorecard submit failed (${run.status}): ${JSON.stringify(run.json)}`);
  let rec;
  for (let i = 0; i < (pollMinutes * 60) / 2; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${id}`);
    process.stdout.write(`  status=${rec.status} settled=${rec.scorecard?.results?.length ?? 0}   \r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  final status=${rec.status}`);
  return rec;
};

// ── images + leftovers ────────────────────────────────────────────────────────
console.log("=== ⓪ build topology images ===");
sh("docker", ["build", "-q", "-t", "sse-relay-command:v1", `${BUNDLE_DIR}/command-server`], { stdio: "inherit" });
sh("docker", ["build", "-q", "-t", "sse-relay-relay:v1", `${BUNDLE_DIR}/relay-server`], { stdio: "inherit" });
sh(
  "docker",
  ["build", "-q", "-t", "sse-relay-client-host:v1", "-f", `${BUNDLE_DIR}/client-host/Dockerfile`, BUNDLE_DIR],
  { stdio: "inherit" },
);
const leftover = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
if (leftover) sh("docker", ["rm", "-f", ...leftover.split("\n")], { stdio: "ignore" });
try {
  sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
} catch {}

console.log(`\n=== ① start control plane (dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
const runnerProcs = [];
let ok = false;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  console.log(`\n=== ② pair + start ${RUNNERS} runner PROCESSES (1 worker each, personal pool) ===`);
  const runnerIds = [];
  for (let i = 0; i < RUNNERS; i++) {
    const paired = await post("/runners", { label: `pool-${i}`, capabilities: ["git"] });
    const token = paired.json.token;
    const id = paired.json.runner?.id;
    if (!token || !id) throw new Error(`pairing ${i} failed: ${JSON.stringify(paired.json)}`);
    runnerIds.push(id);
    const proc = spawn(
      "node",
      [
        "apps/cli/dist/main.js",
        "runner",
        "--pair",
        token,
        "--api-url",
        BASE,
        "--poll-interval-ms",
        "500",
        "--ready-timeout-ms",
        "180000",
      ],
      { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stderr.on("data", (d) => process.stderr.write(`  [r${i}] ${d}`));
    runnerProcs.push(proc);
  }
  console.log(`  paired: ${runnerIds.join(", ")}`);
  await sleep(3500); // all 8 MCP sessions connected

  console.log("\n=== ③ apply the sse-relay-bench bundle ===");
  const bundle = JSON.parse(readFileSync(`${BUNDLE_DIR}/bundle.json`, "utf8"));
  const applied = await post("/bundles/apply", bundle);
  if ((applied.json.results ?? []).some((r) => r.status === "failed"))
    throw new Error(`bundle apply failed: ${JSON.stringify(applied.json.results)}`);

  // ④ warmup — ONE case through the pool: whichever runner takes it deploys the warm topology. The
  // other seven then ADOPT this exact container set (cross-process cold-deploy has no single-flight,
  // so the warm-then-adopt order is the designed multi-process pattern).
  const warm = await runScorecard(
    "warmup: 1 case deploys the topology",
    {
      dataset: { id: "sse-relay-parallel", version: VERSION },
      harness: { id: HARNESS },
      runtime: "self",
      cases: { limit: 1 },
    },
    10,
  );
  check(warm.status === "succeeded", "warmup: scorecard succeeded");
  const idsBefore = topologyContainerIds();
  check(idsBefore.length === 4, `warmup: topology is up (4 containers, got ${idsBefore.length})`);

  // ⑤ the 8-wide batch across the pool — 8 queued jobs, 8 idle single-worker runners.
  const rec = await runScorecard(
    "main: 8 cases × concurrency 8 × runtime self",
    {
      dataset: { id: "sse-relay-parallel", version: VERSION },
      harness: { id: HARNESS },
      runtime: "self",
      concurrency: 8,
    },
    12,
  );

  console.log("\n=== ⑥ verdict ===");
  const results = rec.scorecard?.results ?? [];
  check(rec.status === "succeeded", "main: scorecard succeeded");
  check(results.length === 8, `main: 8 case results (got ${results.length})`);
  const summaries = [];
  for (const r of results) {
    const am = (r.scores ?? []).find((s) => s.graderId === "answer-match");
    check(am?.pass === true, `${r.caseId}: answer-match pass (${am?.detail ?? "-"})`);
    check(r.provenance?.ranOn === "self-hosted", `${r.caseId}: ran self-hosted (runner=${r.provenance?.runner})`);
    try {
      summaries.push(JSON.parse(r.snapshot?.output ?? "{}"));
    } catch {
      failures.push(`${r.caseId}: unparsable observation`);
    }
  }
  // ① pool distribution — every case on a different runner process.
  const usedRunners = new Set(results.map((r) => r.provenance?.runner).filter(Boolean));
  check(
    usedRunners.size === RUNNERS,
    `8 DISTINCT runner processes ran the 8 cases (got ${usedRunners.size}: ${[...usedRunners].map((r) => r.slice(0, 8)).join(", ")})`,
  );
  check(
    [...usedRunners].every((r) => runnerIds.includes(r)),
    "every executing runner is one of the paired pool runners",
  );
  // ② cross-process adoption — the deployer's containers survived seven adopting processes untouched.
  const idsAfter = topologyContainerIds();
  check(
    JSON.stringify(idsAfter) === JSON.stringify(idsBefore),
    "container IDs unchanged across the 8-wide batch (7 processes adopted, none killed/redeployed)",
  );
  // ③ 8-wide parallelism observed inside the topology.
  const client = await serviceStats(`${NETWORK}-client-host`, 8002);
  const relay = await serviceStats(`${NETWORK}-relay`, 8001);
  const command = await serviceStats(`${NETWORK}-command`, 8000);
  const overlap = maxOverlap(command.runs ?? []);
  check(client.peak === 8, `8 concurrent browser sessions at peak (got ${client.peak})`);
  check(relay.peak >= 8, `8 concurrent SSE streams at peak (got ${relay.peak})`);
  check(overlap === 8, `8 agent runs simultaneously in flight (overlap=${overlap})`);
  // ④ isolation under multi-process parallelism.
  const leaked = summaries.reduce((n, s) => n + (s.leaked ?? 99), 0);
  const missing = summaries.reduce((n, s) => n + (s.missing ?? 99), 0);
  const sessions = new Set(summaries.map((s) => s.session_id));
  check(leaked === 0, `zero cross-session leakage (leaked=${leaked})`);
  check(missing === 0, `zero message loss (missing=${missing})`);
  check(sessions.size === 8, `8 distinct browser sessions (got ${sessions.size})`);
  const nonces = summaries.flatMap((s) => s.nonces ?? []);
  check(new Set(nonces).size === nonces.length, "per-case nonce sets are disjoint");

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — 8 runner processes drove the topology scorecard 8-wide on the personal pool: one deployed, seven adopted, zero interference."
      : `\n❌ FAIL — ${failures.length} check(s) failed:\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const p of runnerProcs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  try {
    cp.kill("SIGKILL");
  } catch {}
  if (!process.env.KEEP) {
    try {
      const names = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
      if (names) sh("docker", ["rm", "-f", ...names.split("\n")], { stdio: "ignore" });
      sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
    } catch {}
  }
}
process.exit(ok ? 0 : 1);
