// Live soak: **50 topology scorecards queued at once on a MIXED runner fleet** — 4 CLI runner
// processes (the standalone `everdict runner` flavor, 1 worker each) + 1 in-process RunnerHost with
// 4 workers (the EXACT engine the desktop app's main process embeds — GUI-free by design, so this
// drives the desktop runner's real code path without an Electron shell). 8 case slots total.
//
// Proves, under a deep backlog (50 batches × 8 cases = 400 case runs):
//   ① every scorecard completes: 50/50 succeeded, 400/400 cases pass, zero leakage/loss;
//   ② BOTH runner flavors keep working end-to-end: all five runners execute cases throughout,
//     all four CLI processes are still alive at the end, RunnerHost never leaves running/idle;
//   ③ capacity discipline: concurrent sessions/agent-runs never exceed the 8 slots while the
//     queue holds hundreds of waiting jobs (GET /queue shows the backlog draining);
//   ④ endurance hygiene: ONE warm topology serves all 400 cases (container IDs stable), and the
//     client-host's per-session browser profiles are reclaimed (no unbounded /tmp growth).
//
// Usage: node scripts/live/sse-relay-soak-50.mjs   (docker + apps/api/dist + apps/cli/dist +
//   packages/self-hosted-runner/dist built). Takes ~15-25 minutes. KEEP=1 keeps the topology up.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PORT = process.env.CP_PORT ?? "8795";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const HARNESS = "sse-relay-bench";
const VERSION = "1.0.0";
const NETWORK = `everdict-${HARNESS}-${VERSION}`;
const SCORECARDS = Number(process.env.SOAK_SCORECARDS ?? 50);
const CLI_RUNNERS = 4;
const DESKTOP_WORKERS = 4;
const CASES_PER_CARD = 8;
const SOAK_BUDGET_MIN = 45;
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
const servicePort = (container, port) =>
  sh("docker", ["port", container, String(port)])
    .trim()
    .split("\n")[0]
    .split(":")
    .pop();
const serviceStats = async (container, port) =>
  (await fetch(`http://127.0.0.1:${servicePort(container, port)}/stats`)).json();
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
// Aggregate the /queue snapshot into (active, waiting) case counts — backlog evidence. The snapshot's
// lanes live under workspace[] (shared pools/runtimes) + personal[] (my runners), each item carrying a
// per-batch progress {active, waiting}; parked-not-yet-attached entries appear in lane.queued.
const queueDepth = (snap) => {
  let active = 0;
  let waiting = 0;
  for (const lane of [...(snap?.workspace ?? []), ...(snap?.personal ?? [])]) {
    for (const item of lane.running ?? []) {
      active += item.progress?.active ?? 0;
      waiting += item.progress?.waiting ?? 0;
    }
    waiting += (lane.queued ?? []).length;
  }
  return { active, waiting };
};

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
const cliProcs = [];
let host;
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

  console.log(
    `\n=== ② mixed fleet: ${CLI_RUNNERS} CLI runner processes + RunnerHost(desktop core, ${DESKTOP_WORKERS} workers) ===`,
  );
  const pair = async (label) => {
    const paired = await post("/runners", { label, capabilities: ["git"] });
    if (!paired.json.token || !paired.json.runner?.id)
      throw new Error(`pairing ${label} failed: ${JSON.stringify(paired.json)}`);
    return { id: paired.json.runner.id, token: paired.json.token };
  };
  const cliIds = [];
  for (let i = 0; i < CLI_RUNNERS; i++) {
    const { id, token } = await pair(`soak-cli-${i}`);
    cliIds.push(id);
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
    proc.stderr.on("data", (d) => process.stderr.write(`  [cli${i}] ${d}`));
    cliProcs.push(proc);
  }
  // The desktop flavor: RunnerHost is the desktop main process's runner engine (GUI-free facade over
  // the same lease loop) — driving it in-process IS the desktop runner minus the Electron window.
  const desktop = await pair("soak-desktop-core");
  const shr = await import(pathToFileURL(`${ROOT}packages/self-hosted-runner/dist/index.js`).href);
  let hostJobsDone = 0;
  host = new shr.RunnerHost({
    apiUrl: BASE,
    token: desktop.token,
    maxConcurrent: DESKTOP_WORKERS,
    onJobDone: () => {
      hostJobsDone += 1;
    },
    log: (m) => process.stderr.write(`  [desktop] ${m}\n`),
  });
  await host.start();
  console.log(`  cli runners: ${cliIds.join(", ")}\n  desktop-core runner: ${desktop.id}`);
  await sleep(3500);

  console.log("\n=== ③ apply bundle + warmup (one case deploys the warm topology) ===");
  const bundle = JSON.parse(readFileSync(`${BUNDLE_DIR}/bundle.json`, "utf8"));
  const applied = await post("/bundles/apply", bundle);
  if ((applied.json.results ?? []).some((r) => r.status === "failed"))
    throw new Error(`bundle apply failed: ${JSON.stringify(applied.json.results)}`);
  const warmSubmit = await post("/scorecards", {
    dataset: { id: "sse-relay-parallel", version: VERSION },
    harness: { id: HARNESS },
    runtime: "self",
    cases: { limit: 1 },
  });
  if (!warmSubmit.json.id) throw new Error(`warmup submit failed: ${JSON.stringify(warmSubmit.json)}`);
  let warm;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    warm = await get(`/scorecards/${warmSubmit.json.id}`);
    if (warm.status === "succeeded" || warm.status === "failed") break;
  }
  check(warm.status === "succeeded", "warmup: scorecard succeeded (topology deployed)");
  const idsBefore = topologyContainerIds();
  check(idsBefore.length === 4, `warmup: topology is up (4 containers, got ${idsBefore.length})`);

  console.log(`\n=== ④ queue ${SCORECARDS} scorecards (8 cases × concurrency 8 × runtime self) ===`);
  const t0 = Date.now();
  const cardIds = [];
  for (let i = 0; i < SCORECARDS; i++) {
    const r = await post("/scorecards", {
      dataset: { id: "sse-relay-parallel", version: VERSION },
      harness: { id: HARNESS },
      runtime: "self",
      concurrency: 8,
    });
    if (!r.json.id) throw new Error(`submit ${i} failed (${r.status}): ${JSON.stringify(r.json)}`);
    cardIds.push(r.json.id);
  }
  console.log(`  submitted ${cardIds.length} scorecards in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Drain watch — one status line every ~12s: terminal cards, settled cases, live queue depth, live sessions.
  let peakWaiting = 0;
  const terminal = new Map();
  const deadline = Date.now() + SOAK_BUDGET_MIN * 60_000;
  while (terminal.size < cardIds.length && Date.now() < deadline) {
    await sleep(12_000);
    let settledCases = 0;
    for (const id of cardIds) {
      if (terminal.has(id)) {
        settledCases += terminal.get(id).scorecard?.results?.length ?? 0;
        continue;
      }
      const rec = await get(`/scorecards/${id}`);
      settledCases += rec.scorecard?.results?.length ?? 0;
      if (rec.status === "succeeded" || rec.status === "failed") terminal.set(id, rec);
    }
    const q = await get("/queue").catch(() => undefined);
    const depth = queueDepth(q);
    peakWaiting = Math.max(peakWaiting, depth.waiting);
    const sessions = await serviceStats(`${NETWORK}-client-host`, 8002).catch(() => ({}));
    const cliAlive = cliProcs.filter((p) => p.exitCode === null).length;
    console.log(
      `  t=${Math.round((Date.now() - t0) / 1000)}s cards=${terminal.size}/${cardIds.length} cases=${settledCases}/${
        cardIds.length * CASES_PER_CARD
      } queue(active=${depth.active},waiting=${depth.waiting}) sessions(now=${sessions.active_now ?? "?"},peak=${sessions.peak ?? "?"}) cli-alive=${cliAlive}/${CLI_RUNNERS} desktop=${host.status().state}(${hostJobsDone} done)`,
    );
  }
  const wallMin = ((Date.now() - t0) / 60_000).toFixed(1);

  console.log(`\n=== ⑤ verdict (wall ${wallMin} min) ===`);
  check(terminal.size === cardIds.length, `all ${cardIds.length} scorecards reached a terminal state`);
  const records = [...terminal.values()];
  const succeeded = records.filter((r) => r.status === "succeeded").length;
  check(succeeded === cardIds.length, `all scorecards succeeded (${succeeded}/${cardIds.length})`);
  const results = records.flatMap((r) => r.scorecard?.results ?? []);
  check(
    results.length === cardIds.length * CASES_PER_CARD,
    `${cardIds.length * CASES_PER_CARD} case results (got ${results.length})`,
  );
  const passed = results.filter((r) => (r.scores ?? []).some((s) => s.graderId === "answer-match" && s.pass)).length;
  check(passed === results.length, `every case passed answer-match (${passed}/${results.length})`);
  const summaries = results.map((r) => {
    try {
      return JSON.parse(r.snapshot?.output ?? "{}");
    } catch {
      return {};
    }
  });
  const leaked = summaries.reduce((n, s) => n + (s.leaked ?? 99), 0);
  const missing = summaries.reduce((n, s) => n + (s.missing ?? 99), 0);
  check(leaked === 0, `zero cross-session leakage across the soak (leaked=${leaked})`);
  check(missing === 0, `zero message loss across the soak (missing=${missing})`);
  const sessions = new Set(summaries.map((s) => s.session_id));
  check(sessions.size === results.length, `${results.length} distinct browser sessions (got ${sessions.size})`);

  // ② both flavors, sustained: distribution + end-of-soak liveness.
  const byRunner = new Map();
  for (const r of results) {
    const id = r.provenance?.runner;
    byRunner.set(id, (byRunner.get(id) ?? 0) + 1);
  }
  console.log(
    `  case distribution: ${[...byRunner.entries()].map(([id, n]) => `${id === desktop.id ? "desktop" : `cli(${String(id).slice(0, 8)})`}=${n}`).join(" · ")}`,
  );
  const desktopCases = byRunner.get(desktop.id) ?? 0;
  check(desktopCases >= 40, `the desktop-core runner carried real load (${desktopCases} cases, 4/8 slots)`);
  for (let i = 0; i < cliIds.length; i++)
    check(
      (byRunner.get(cliIds[i]) ?? 0) >= 10,
      `cli runner ${i} carried real load (${byRunner.get(cliIds[i]) ?? 0} cases)`,
    );
  check(
    cliProcs.every((p) => p.exitCode === null),
    "all CLI runner processes still alive after the soak",
  );
  check(
    host.status().state !== "off",
    `RunnerHost still up after the soak (state=${host.status().state}, ${hostJobsDone} jobs done)`,
  );
  check(hostJobsDone === desktopCases, `RunnerHost job-done count matches its provenance count (${hostJobsDone})`);

  // ③ capacity discipline under backlog + ④ endurance hygiene.
  const client = await serviceStats(`${NETWORK}-client-host`, 8002);
  const command = await serviceStats(`${NETWORK}-command`, 8000);
  const overlap = maxOverlap(command.runs ?? []);
  check(client.peak === 8, `sessions never exceeded the 8 slots (peak=${client.peak})`);
  check(overlap === 8, `agent-run overlap saturated at exactly the 8 slots (overlap=${overlap})`);
  check(peakWaiting >= 100, `a real backlog was observed in GET /queue (peak waiting=${peakWaiting})`);
  const idsAfter = topologyContainerIds();
  check(
    JSON.stringify(idsAfter) === JSON.stringify(idsBefore),
    "ONE warm topology served all cases (container IDs unchanged through the soak)",
  );
  const leftoverProfiles = Number(
    sh("docker", ["exec", `${NETWORK}-client-host`, "sh", "-c", "ls /tmp | grep -c pw- || true"]).trim() || "0",
  );
  check(
    leftoverProfiles <= 16,
    `browser profiles reclaimed after ${results.length} sessions (${leftoverProfiles} left in /tmp)`,
  );
  console.log(`  throughput: ${(results.length / Number(wallMin)).toFixed(1)} cases/min over ${wallMin} min`);

  ok = failures.length === 0;
  console.log(
    ok
      ? `\n✅ PASS — ${cardIds.length} queued scorecards drained clean on the mixed CLI+desktop-core fleet: both flavors ran the whole soak, capacity held at 8, zero interference.`
      : `\n❌ FAIL — ${failures.length} check(s) failed:\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  try {
    await host?.stop();
  } catch {}
  for (const p of cliProcs) {
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
