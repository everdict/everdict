// Live chaos suite: **failure injection against the topology eval loop on a Postgres-backed control
// plane** — the three outages a self-hosted fleet actually meets, each with a recovery assertion:
//
//   R) runner SIGKILL mid-batch — its leased cases' heartbeats stop, the lease TTL (2 min) expires,
//      the hub requeues them, and the surviving runner finishes the batch: scorecard still 8/8.
//   C) control-plane restart — runners' ResilientMcpSession re-initializes against the new process;
//      pairing survives (rnr_ token hashes live in Postgres, not process memory); a fresh scorecard
//      completes on the SAME runner identities.
//   T) warm-topology container kill (docker rm -f the relay) — the next ensureTopology's liveness
//      check detects the dead set, redeploys, and a fresh scorecard passes 8/8 with a NEW relay
//      container id (self-heal, no manual intervention).
//
// Usage: node scripts/live/sse-relay-chaos.mjs   (docker + api/cli dists built; ~12 min — phase R
//   waits out the 2-minute lease TTL). KEEP=1 keeps the topology + postgres up afterwards.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8798";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const NETWORK = "everdict-sse-relay-bench-1.0.0";
const PG_NAME = "everdict-chaos-pg";
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

const submitAndWait = async (label, body, minutes) => {
  const sub = await post("/scorecards", body);
  if (!sub.json.id) throw new Error(`${label} submit failed (${sub.status}): ${JSON.stringify(sub.json)}`);
  let rec;
  for (let i = 0; i < (minutes * 60) / 2; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${sub.json.id}`);
    process.stdout.write(`  [${label}] status=${rec.status} settled=${rec.scorecard?.results?.length ?? 0}   \r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  [${label}] final=${rec.status}`);
  return rec;
};
const allPass = (rec) =>
  (rec.scorecard?.results ?? []).length === 8 &&
  (rec.scorecard?.results ?? []).every((r) => (r.scores ?? []).some((s) => s.graderId === "answer-match" && s.pass));

console.log("=== ⓪ images + a fresh Postgres (the control-plane store) ===");
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
sh("docker", ["rm", "-f", PG_NAME], { stdio: "ignore" });
sh("docker", [
  "run",
  "-d",
  "--name",
  PG_NAME,
  "-p",
  "127.0.0.1::5432",
  "-e",
  "POSTGRES_USER=everdict",
  "-e",
  "POSTGRES_PASSWORD=everdict",
  "-e",
  "POSTGRES_DB=everdict",
  "postgres:16-alpine",
]);
const pgPort = sh("docker", ["port", PG_NAME, "5432"]).trim().split("\n")[0].split(":").pop();
const DATABASE_URL = `postgresql://everdict:everdict@127.0.0.1:${pgPort}/everdict`;
for (let i = 0; i < 30; i++) {
  try {
    sh("docker", ["exec", PG_NAME, "pg_isready", "-U", "everdict"]);
    break;
  } catch {
    await sleep(1000);
  }
}
console.log(`  postgres up on :${pgPort}`);

const cpEnv = { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL };
const startCp = () => {
  const proc = spawn("node", ["apps/api/dist/main.js"], { cwd: ROOT, env: cpEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
  return proc;
};
const waitCpUp = async () => {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      if ((await fetch(`${BASE}/datasets`, { headers: H })).status === 200) return;
    } catch {}
  }
  throw new Error("control plane failed to start");
};

console.log(`\n=== ① Postgres-backed control plane (:${PORT}) + 2 runners (2 workers each) ===`);
let cp = startCp();
const procs = [];
const tokens = [];
const runnerIds = [];
const spawnRunner = (i, token) => {
  const proc = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      token,
      "--api-url",
      BASE,
      "--max-concurrent",
      "2",
      "--poll-interval-ms",
      "500",
      "--ready-timeout-ms",
      "180000",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stderr.on("data", (d) => process.stderr.write(`  [r${i}] ${d}`));
  procs[i] = proc;
};
let ok = false;
try {
  await waitCpUp();
  for (let i = 0; i < 2; i++) {
    const paired = await post("/runners", { label: `chaos-${i}`, capabilities: ["git"] });
    if (!paired.json.token || !paired.json.runner?.id) throw new Error(`pairing ${i} failed`);
    tokens.push(paired.json.token);
    runnerIds.push(paired.json.runner.id);
    spawnRunner(i, paired.json.token);
  }
  await sleep(3000);
  const applied = await post("/bundles/apply", JSON.parse(readFileSync(`${BUNDLE_DIR}/bundle.json`, "utf8")));
  if ((applied.json.results ?? []).some((r) => r.status === "failed")) throw new Error("bundle apply failed");
  const warm = await submitAndWait(
    "warmup",
    {
      dataset: { id: "sse-relay-parallel", version: "1.0.0" },
      harness: { id: "sse-relay-bench" },
      runtime: "self",
      cases: { limit: 1 },
    },
    8,
  );
  check(warm.status === "succeeded", "warmup succeeded (topology deployed)");

  // ── R: runner SIGKILL mid-batch ─────────────────────────────────────────────
  console.log("\n=== ② phase R: SIGKILL runner-0 mid-batch → lease TTL requeue → survivor finishes ===");
  const rPromise = submitAndWait(
    "R",
    {
      dataset: { id: "sse-relay-parallel", version: "1.0.0" },
      harness: { id: "sse-relay-bench" },
      runtime: "self",
      concurrency: 4,
    },
    10, // budget covers the 2-minute lease TTL + re-runs
  );
  await sleep(12_000); // let cases lease and enter flight on both runners
  procs[0].kill("SIGKILL");
  console.log("  >>> runner-0 SIGKILLed with cases in flight");
  const rRec = await rPromise;
  check(rRec.status === "succeeded", "R: scorecard still succeeded after the runner died");
  check(allPass(rRec), "R: all 8 cases pass (requeued cases re-ran cleanly)");
  const rRunners = new Set((rRec.scorecard?.results ?? []).map((r) => r.provenance?.runner));
  check(rRunners.has(runnerIds[1]), "R: the surviving runner executed cases");

  // ── C: control-plane restart ────────────────────────────────────────────────
  console.log("\n=== ③ phase C: control-plane SIGKILL + restart → runners reconnect, pairing survives in Postgres ===");
  cp.kill("SIGKILL");
  await sleep(3000);
  cp = startCp();
  await waitCpUp();
  spawnRunner(0, tokens[0]); // revive runner-0 with its ORIGINAL token — its identity must still exist in PG
  await sleep(15_000); // give both runners' resilient sessions time to reconnect
  const cRec = await submitAndWait(
    "C",
    {
      dataset: { id: "sse-relay-parallel", version: "1.0.0" },
      harness: { id: "sse-relay-bench" },
      runtime: "self",
      concurrency: 4,
    },
    8,
  );
  check(cRec.status === "succeeded", "C: a fresh scorecard succeeded after the control-plane restart");
  check(allPass(cRec), "C: all 8 cases pass post-restart");
  const cRunners = new Set((cRec.scorecard?.results ?? []).map((r) => r.provenance?.runner));
  check(
    [...cRunners].every((r) => runnerIds.includes(r)),
    "C: cases ran on the ORIGINAL runner identities (pairing persisted in Postgres)",
  );

  // ── T: warm-topology container kill ─────────────────────────────────────────
  console.log("\n=== ④ phase T: docker rm -f the warm relay container → self-heal redeploy ===");
  const relayBefore = sh("docker", ["ps", "-q", "--filter", `name=${NETWORK}-relay`]).trim();
  sh("docker", ["rm", "-f", `${NETWORK}-relay`]);
  console.log("  >>> relay container killed under the warm topology");
  const tRec = await submitAndWait(
    "T",
    {
      dataset: { id: "sse-relay-parallel", version: "1.0.0" },
      harness: { id: "sse-relay-bench" },
      runtime: "self",
      concurrency: 4,
    },
    8,
  );
  check(tRec.status === "succeeded", "T: scorecard succeeded after the topology was maimed");
  check(allPass(tRec), "T: all 8 cases pass against the self-healed topology");
  const relayAfter = sh("docker", ["ps", "-q", "--filter", `name=${NETWORK}-relay`]).trim();
  check(
    relayAfter !== "" && relayAfter !== relayBefore,
    `T: the relay was REDEPLOYED (container ${relayBefore.slice(0, 8)} → ${relayAfter.slice(0, 8)})`,
  );

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — all three outages recovered without intervention: runner death (lease requeue), control-plane restart (PG pairing + MCP reconnect), topology container loss (warm-pool self-heal)."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const p of procs) {
    try {
      p?.kill("SIGKILL");
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
      sh("docker", ["rm", "-f", PG_NAME], { stdio: "ignore" });
    } catch {}
  }
}
process.exit(ok ? 0 : 1);
