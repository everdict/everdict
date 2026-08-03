// Live: a BATCH of extension cases against one session server, driven by the real `runSuite`, checking the three
// things mass testing needs — each case individually watchable while it runs, each case's environment recorded for
// replay, and what the infrastructure looks like underneath.
//
// Phase A (concurrency <= the session pool): every case gets its own live screen and its own recording.
// Phase B (concurrency  > the session pool): the batch outruns the pool. The scheduler admits against cluster
//   slots, which say nothing about how many browsers a service holds, so the overflow arrives at a full pool —
//   and `acquire.wait` is what turns that refusal into a queue rather than a batch of infra failures.
//
// Prereqs: docker. Run:  node scripts/live/spica-batch-live-replay.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { runSuite } from "../../packages/application-control/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const SERVER_DIR = new URL("../../examples/servers/spica-playwright-server/", import.meta.url).pathname;
const CONTAINER = "spica-batch-drill";
const PORT = Number(process.env.SPICA_PORT ?? 18082);
const BASE = `http://127.0.0.1:${PORT}`;
const POOL = Number(process.env.SPICA_POOL ?? 4); // MAX_CONCURRENT_BROWSERS in the session server
const CASES = Number(process.env.SPICA_CASES ?? 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (a) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const dtry = (a) => {
  try {
    return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
};
const getJson = async (url) => (await fetch(url)).json(); // used for the process view only

async function startServer() {
  console.log("▶ images");
  docker(["build", "-q", "-t", "spica-playwright-server:0.1.0", SERVER_DIR]);
  docker(["build", "-q", "-t", "spica-playwright-server:fixture", "-f", `${SERVER_DIR}Dockerfile.fixture`, SERVER_DIR]);
  dtry(["rm", "-f", CONTAINER]);
  docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "--network",
    "host",
    "--shm-size=2g",
    "-e",
    `PORT=${PORT}`,
    "-e",
    `MAX_CONCURRENT_BROWSERS=${POOL}`,
    "-e",
    "SPICA_CDP_EXPOSE=1",
    "-e",
    "SPICA_CDP_ADVERTISED_HOST=127.0.0.1",
    "spica-playwright-server:fixture",
  ]);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("the session server never became healthy");
}

const SPEC = {
  kind: "service",
  id: "spica-session",
  version: "1.0.0",
  services: [
    {
      name: "spica",
      image: "spica-playwright-server:fixture",
      port: PORT,
      needs: [],
      perRun: [],
      replicas: 1,
      env: {},
    },
  ],
  dependencies: [],
  target: {
    kind: "browser",
    engine: "chromium",
    lifecycle: "per-case-instance",
    observe: ["url"],
    acquire: {
      mode: "service",
      service: "spica",
      open: "POST /start-browser",
      coordinates: { session_id: "session_ids.0" },
      close: "POST /stop-browser/{session_id}?force=true",
      cdpBase: "sessions.0.cdp_url",
      // Where the pool that actually limits this batch reports itself. It lives inside the service container, so
      // without this the roster can only say "the service is running" while cases are being refused.
      capacity: { poll: "GET /health", total: "max_browsers", used: "active_browsers" },
      // A batch wider than the pool waits for the cases ahead of it instead of failing on the pool's refusal.
      wait: { timeoutMs: 120_000, intervalMs: 300 },
    },
  },
  frontDoor: {
    service: "spica",
    submit: "POST /navigate",
    request: { bodyTemplate: { session_id: "{{session_id}}", url: "{{task}}" } },
  },
  traceSource: { kind: "mlflow", endpoint: "http://unused" },
};

// Distinct hosts so a recording proves it belongs to ITS case, but all of them stable: a flaky third-party site
// would fail a case for reasons that say nothing about live/replay.
const SITES = [
  "https://example.com/",
  "https://www.wikipedia.org/",
  "https://www.iana.org/",
  "https://example.net/",
  "https://example.org/",
  "https://www.w3.org/",
];

function makeBackend(batchId, recordings) {
  return new ServiceTopologyBackend({
    runtime: {
      id: "docker-local",
      async ensureTopology() {
        return { endpoints: { spica: BASE } };
      },
      async provisionBrowserEnv() {
        throw new Error("must not be called — the session API owns the browser");
      },
      // What an orchestrator can see by itself: the container is up. Everything about the sessions inside it has
      // to come from the service's own report.
      async describeTopology() {
        return {
          deployed: true,
          runtime: "docker",
          services: [{ name: "spica", status: "running", ready: true, events: [] }],
        };
      },
    },
    traceSource: {
      async fetch() {
        return [];
      },
    },
    specFor: () => SPEC,
    // Per-case recording, keyed the way the control plane keys it: one bucket per run.
    recordSink: (runId) => {
      if (!recordings[runId]) recordings[runId] = { tracks: [], frames: 0 };
      const bucket = recordings[runId];
      return {
        track: (item) => bucket.tracks.push(item),
        frame: () => {
          bucket.frames += 1;
        },
      };
    },
  });
}

async function runBatch(label, concurrency) {
  const batchId = `batch-${label}`;
  const recordings = {};
  const backend = makeBackend(batchId, recordings);
  const suite = {
    id: "spica-suite",
    harness: { id: SPEC.id },
    cases: SITES.slice(0, CASES).map((url, i) => ({
      id: `c${i + 1}`,
      env: { kind: "browser" },
      task: url,
      graders: [],
      timeoutSec: 120,
      tags: [],
    })),
  };
  // The control plane stamps a record-derivable runId on every dispatched case; the drill does the same so each
  // case is individually addressable for a live read.
  const runIdFor = (caseId) => `evd-${batchId}-${caseId}`;
  const dispatch = (job) => backend.dispatch({ ...job, tenant: "drill", runId: runIdFor(job.evalCase.id) });

  const live = {};
  for (const c of suite.cases) live[c.id] = { hits: 0, maxKb: 0 };
  let polling = true;
  // One independent watcher per case, not one synchronized sweep: a sweep advances at the speed of its slowest
  // capture, so a case that lives two seconds can pass between samples and read as "never watchable" when it was.
  const poller = Promise.all(
    suite.cases.map(async (c) => {
      while (polling) {
        const frame = await backend.captureScreen(runIdFor(c.id)).catch(() => undefined);
        if (frame) {
          live[c.id].hits += 1;
          live[c.id].maxKb = Math.max(live[c.id].maxKb, Math.round((frame.length * 3) / 4 / 1024));
        }
        await sleep(150);
      }
    }),
  );

  // The infra read an operator actually has: GET /runs/:id/topology, i.e. the engine's own roster — NOT a direct
  // call to the session server. The pool line only appears here if the harness's capacity declaration works.
  const infra = { peak: 0, total: 0, samples: 0, sawPool: false, full: 0 };
  const infraWatch = (async () => {
    while (polling) {
      const status = await backend
        .inspectTopology({ id: SPEC.id, version: SPEC.version }, "drill")
        .catch(() => undefined);
      if (status?.pool) {
        infra.sawPool = true;
        infra.total = status.pool.total;
        infra.peak = Math.max(infra.peak, status.pool.used ?? 0);
        if ((status.pool.used ?? 0) >= status.pool.total) infra.full += 1;
      }
      infra.samples += 1;
      await sleep(200);
    }
  })();

  const t0 = Date.now();
  const scorecard = await runSuite(suite, SPEC.version, dispatch, { concurrency });
  polling = false;
  await Promise.all([poller, infraWatch]);
  const elapsed = Date.now() - t0;

  const procs = await getJson(`${BASE}/debug/processes`);
  const browsers = procs.processes.filter((p) => p.role === "browser").length;

  // Judged over the cases that actually RAN: a case refused for want of a session (or killed by a flaky site)
  // has nothing to watch or record, and counting it as a coverage miss would hide the real number.
  const ran = scorecard.results.filter((r) => !r.failure).map((r) => r.caseId);
  const failed = scorecard.results.length - ran.length;
  // Separate the failure this drill is actually about (the pool refused a case) from the ones it is not (a
  // third-party site fell over). Only the first says anything about Everdict.
  const poolRefusals = scorecard.results.filter((r) =>
    String(r.failure?.message ?? "").includes("CAPACITY_EXCEEDED"),
  ).length;
  const watched = ran.filter((id) => live[id]?.hits > 0).length;
  const recorded = ran.filter((id) => {
    const r = recordings[runIdFor(id)];
    return (r?.tracks.length ?? 0) > 0 || (r?.frames ?? 0) > 0;
  }).length;

  console.log(`\n── ${label} (cases=${suite.cases.length} concurrency=${concurrency} pool=${POOL}) ──`);
  console.log(`  outcome:     ${scorecard.results.length - failed} ok / ${failed} failed   (${elapsed}ms)`);
  console.log(`  live:        ${watched}/${ran.length} RUNNING cases returned a frame while running`);
  console.log(`    ${suite.cases.map((c) => `${c.id}:${live[c.id].hits}f/${live[c.id].maxKb}KB`).join("  ")}`);
  console.log(`  replay:      ${recorded}/${ran.length} RUNNING cases recorded an environment plane`);
  for (const c of suite.cases) {
    const r = recordings[runIdFor(c.id)];
    const kinds = {};
    for (const t of r?.tracks ?? []) kinds[t.track] = (kinds[t.track] ?? 0) + 1;
    const nav = (r?.tracks ?? []).find((t) => t.track === "nav")?.entry.url ?? "-";
    console.log(`    ${c.id}: frames=${r?.frames ?? 0} ${JSON.stringify(kinds)} nav=${nav}`);
  }
  console.log(
    `  infra:       ${infra.sawPool ? `pool visible in the roster — peak ${infra.peak}/${infra.total} sessions, saturated in ${infra.full}/${infra.samples} reads` : "NO POOL IN THE ROSTER"}`,
  );
  console.log(`  after batch: ${browsers} browser process(es) left, ${procs.orphan_profiles.length} orphan profile(s)`);
  if (failed) {
    const first = scorecard.results.find((r) => r.failure);
    console.log(`  first failure: ${first.failure.class} — ${String(first.failure.message).slice(0, 120)}`);
  }
  return { failed, poolRefusals, watched, recorded, total: ran.length, browsers, sawPool: infra.sawPool };
}

async function main() {
  await startServer();

  const a = await runBatch("A: within the pool", Math.max(1, POOL - 1));
  const b = await runBatch("B: outrunning the pool", CASES);

  console.log("\n── verdict ───────────────────────────────────────────────");
  // What the product owes: every case that ran is recorded, the pool is visible, nothing leaks. Live coverage is
  // reported rather than required — a 150ms sampler cannot guarantee it catches a case that lives two seconds,
  // and holding the verdict hostage to that would make the drill flaky about something it cannot measure.
  const aOk = a.recorded === a.total && a.browsers === 0 && a.sawPool && a.watched > 0;
  console.log(
    `  A  every running case recorded (${a.recorded}/${a.total}), live seen on ${a.watched}, pool visible, nothing leaked: ${aOk ? "PASS" : "FAIL"}`,
  );
  const bOk = b.poolRefusals === 0 && b.recorded === b.total && b.browsers === 0;
  console.log(
    `  B  overflow QUEUED on the full pool — ${b.poolRefusals} case(s) refused for capacity (${b.failed} failed for any reason): ${bOk ? "PASS" : "FAIL"}`,
  );
  return aOk && bOk ? 0 : 1;
}

main()
  .then((code) => {
    dtry(["rm", "-f", CONTAINER]);
    process.exit(code);
  })
  .catch((err) => {
    console.error("✗", err?.stack ?? err);
    console.error(dtry(["logs", "--tail", "40", CONTAINER]));
    dtry(["rm", "-f", CONTAINER]);
    process.exit(2);
  });
