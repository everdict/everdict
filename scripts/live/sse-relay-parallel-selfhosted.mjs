// Live e2e: **8-parallel service-topology cases on ONE self-hosted runner** (the desktop runner's
// exact core — apps/desktop wraps the same @everdict/self-hosted-runner lease loop the CLI runner runs).
// Topology: examples/bundles/sse-relay-bench (command front door → Redis Streams → SSE relay →
// Chrome-extension client behind a Playwright wrapping server; no LLM calls, nonce-verified loop).
//
// What it proves, in order:
//   ① the DEFAULT submit (no `concurrency`) runs only 4 cases at a time — the batch-side default,
//     the usual reason "8-parallel doesn't seem to work";
//   ② the same batch with `concurrency: 8` × runner `--max-concurrent 8` runs all 8 cases at once:
//     8 concurrent browser sessions + 8 concurrent SSE streams + 8 concurrent agent runs;
//   ③ the warm topology deployed exactly ONCE (single-flight): one docker network, one container set —
//     parallel cases share the topology and isolate per-session, they do not redeploy it;
//   ④ zero cross-case interference: every case's transcript is complete (missing=0) and leak-free
//     (leaked=0), session ids are unique, and each case's answer-match passes on ok=true.
//
// Usage: node scripts/live/sse-relay-parallel-selfhosted.mjs   (docker + apps/api/dist + apps/cli/dist built)
//   KEEP=1 keeps the warm topology up for inspection after the run.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8793";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const HARNESS = "sse-relay-bench";
const VERSION = "1.0.0";
const NETWORK = `everdict-${HARNESS}-${VERSION}`;
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

// Service /stats via the host-published port of a warm-topology container (the topology stays warm after the batch).
const serviceStats = async (container, port) => {
  const out = sh("docker", ["port", container, String(port)])
    .trim()
    .split("\n")[0];
  const hostPort = out.split(":").pop();
  return (await fetch(`http://127.0.0.1:${hostPort}/stats`)).json();
};

// Max simultaneous [start, end] intervals — the ground-truth agent-run overlap from the command server's log.
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
  const t0 = Date.now();
  const run = await post("/scorecards", body);
  const id = run.json.id;
  if (!id) throw new Error(`scorecard submit failed (${run.status}): ${JSON.stringify(run.json)}`);
  let rec;
  for (let i = 0; i < (pollMinutes * 60) / 2; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${id}`);
    process.stdout.write(`  status=${rec.status} settled=${rec.scorecard?.results?.length ?? 0}/8   \r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  final status=${rec.status} (wall ${wallSec}s)`);
  return { rec, wallSec: Number(wallSec) };
};

const verifyCases = (rec, label) => {
  const results = rec.scorecard?.results ?? [];
  check(rec.status === "succeeded", `${label}: scorecard succeeded`);
  check(results.length === 8, `${label}: 8 case results (got ${results.length})`);
  const summaries = [];
  for (const r of results) {
    const am = (r.scores ?? []).find((s) => s.graderId === "answer-match");
    check(am?.pass === true, `${label}/${r.caseId}: answer-match pass (detail: ${am?.detail ?? "-"})`);
    check(r.provenance?.ranOn === "self-hosted", `${label}/${r.caseId}: provenance self-hosted`);
    try {
      summaries.push(JSON.parse(r.snapshot?.output ?? "{}"));
    } catch {
      failures.push(`${label}/${r.caseId}: unparsable observation`);
    }
  }
  const leaked = summaries.reduce((n, s) => n + (s.leaked ?? 99), 0);
  const missing = summaries.reduce((n, s) => n + (s.missing ?? 99), 0);
  const sessions = new Set(summaries.map((s) => s.session_id));
  check(leaked === 0, `${label}: zero cross-session leakage (leaked=${leaked})`);
  check(missing === 0, `${label}: zero message loss (missing=${missing})`);
  check(sessions.size === 8, `${label}: 8 distinct browser sessions (got ${sessions.size})`);
  const nonces = summaries.flatMap((s) => s.nonces ?? []);
  check(new Set(nonces).size === nonces.length, `${label}: per-case nonce sets are disjoint`);
  return summaries;
};

// ── docker images ─────────────────────────────────────────────────────────────
console.log("=== ⓪ build topology images ===");
sh("docker", ["build", "-t", "sse-relay-command:v1", `${BUNDLE_DIR}/command-server`], { stdio: "inherit" });
sh("docker", ["build", "-t", "sse-relay-relay:v1", `${BUNDLE_DIR}/relay-server`], { stdio: "inherit" });
sh("docker", ["build", "-t", "sse-relay-client-host:v1", "-f", `${BUNDLE_DIR}/client-host/Dockerfile`, BUNDLE_DIR], {
  stdio: "inherit",
});
// leftovers from a previous run would collide on fixed names — clean first (idempotent).
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
  if (!up) throw new Error("control plane failed to start");

  console.log("\n=== ② pair + start ONE runner with --max-concurrent 8 (the desktop pair-time knob) ===");
  const paired = await post("/runners", { label: "sse-relay-parallel", capabilities: ["git"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  if (!token || !runnerId) throw new Error(`pairing failed: ${JSON.stringify(paired.json)}`);
  console.log(`  runnerId=${runnerId}`);
  runner = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      token,
      "--api-url",
      BASE,
      "--max-concurrent",
      "8",
      "--poll-interval-ms",
      "500",
      "--ready-timeout-ms",
      "180000",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  console.log("\n=== ③ apply the sse-relay-bench bundle ===");
  const bundle = JSON.parse(readFileSync(`${BUNDLE_DIR}/bundle.json`, "utf8"));
  const applied = await post("/bundles/apply", bundle);
  for (const r of applied.json.results ?? [])
    console.log(`  ${String(r.status).padEnd(8)} ${r.kind} ${r.id}@${r.version}`);
  if ((applied.json.results ?? []).some((r) => r.status === "failed"))
    throw new Error(`bundle apply failed: ${JSON.stringify(applied.json.results)}`);

  // ④ DEFAULT submit — no `concurrency`: the batch dispatches only 4 cases at a time even though the
  // runner has 8 idle workers. This is the usual "8-parallel doesn't happen" culprit.
  const a = await runScorecard(
    "A: default concurrency (expect 4-wide)",
    { dataset: { id: "sse-relay-parallel", version: VERSION }, harness: { id: HARNESS }, runtime: `self:${runnerId}` },
    12,
  );
  verifyCases(a.rec, "A");
  const clientA = await serviceStats(`${NETWORK}-client-host`, 8002);
  const commandA = await serviceStats(`${NETWORK}-command`, 8000);
  const overlapA = maxOverlap(commandA.runs ?? []);
  check(clientA.peak === 4, `A: browser-session peak is the DEFAULT 4, not 8 (got ${clientA.peak})`);
  check(overlapA <= 4, `A: agent-run overlap capped at 4 by the batch default (got ${overlapA})`);

  // ⑤ the same batch, both knobs at 8 — all cases in flight at once on the one runner.
  const b = await runScorecard(
    "B: concurrency=8 (expect 8-wide)",
    {
      dataset: { id: "sse-relay-parallel", version: VERSION },
      harness: { id: HARNESS },
      runtime: `self:${runnerId}`,
      concurrency: 8,
    },
    12,
  );
  verifyCases(b.rec, "B");
  const clientB = await serviceStats(`${NETWORK}-client-host`, 8002);
  const relayB = await serviceStats(`${NETWORK}-relay`, 8001);
  const commandB = await serviceStats(`${NETWORK}-command`, 8000);
  const overlapB = maxOverlap(commandB.runs ?? []);
  check(clientB.peak === 8, `B: 8 concurrent browser sessions (peak=${clientB.peak})`);
  check(overlapB === 8, `B: 8 agent runs simultaneously in flight (overlap=${overlapB})`);
  check(relayB.peak >= 8, `B: 8 concurrent SSE streams through the relay (peak=${relayB.peak})`);
  console.log(`  wall-clock: default-4 → ${a.wallSec}s · 8-wide → ${b.wallSec}s`);

  // ⑥ single-flight warm topology: parallel cases must NOT have redeployed it.
  console.log("\n=== ⑥ topology deployment shape ===");
  const nets = sh("docker", ["network", "ls", "--format", "{{.Name}}"])
    .trim()
    .split("\n")
    .filter((n) => n.startsWith(`everdict-${HARNESS}`));
  const containers = sh("docker", ["ps", "--format", "{{.Names}}"])
    .trim()
    .split("\n")
    .filter((n) => n.startsWith(NETWORK));
  check(nets.length === 1, `exactly one topology network (got: ${nets.join(", ") || "none"})`);
  check(
    containers.length === 4,
    `one container set — 3 services + redis (got ${containers.length}: ${containers.join(", ")})`,
  );

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — one self-hosted runner drove the SSE-relay topology 8-wide: shared warm topology, per-session isolation intact, both parallelism knobs verified."
      : `\n❌ FAIL — ${failures.length} check(s) failed:\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  try {
    runner?.kill("SIGKILL");
  } catch {}
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
