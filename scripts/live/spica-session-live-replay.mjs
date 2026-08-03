// Live: one case against a SESSION-ACQUIRED, extension-loaded browser, driven through the real
// ServiceTopologyBackend — proving the two things a session target could not do before:
//
//   live    — GET the case's screen WHILE it runs (captureScreen resolves the session's own browser,
//             which the runtime never provisioned and therefore cannot rediscover)
//   replay  — the environment plane (screencast frames + network + console + navigation) lands in the
//             recording sink, keyed to the run, for the player to scrub afterwards
//
// The target is examples/servers/spica-playwright-server with its fixture extension baked in: POST
// /start-browser walks the extension's remote mode and hands back a session id + a reachable CDP base,
// which is what `acquire.cdpBase` declares.
//
// Prereqs: docker. Images are built by this script if missing.
// Run:  node scripts/live/spica-session-live-replay.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const SERVER_DIR = new URL("../../examples/servers/spica-playwright-server/", import.meta.url).pathname;
const CONTAINER = "spica-live-drill";
const PORT = Number(process.env.SPICA_PORT ?? 18081);
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_URL = process.env.SPICA_TASK_URL ?? "https://example.com/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (a) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const dtry = (a) => {
  try {
    return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
};

function buildImages() {
  // Always rebuild: the fixture image is FROM the server image, so a stale base silently drills yesterday's server.
  console.log("  building spica-playwright-server:0.1.0 …");
  docker(["build", "-q", "-t", "spica-playwright-server:0.1.0", SERVER_DIR]);
  console.log("  building spica-playwright-server:fixture …");
  docker(["build", "-q", "-t", "spica-playwright-server:fixture", "-f", `${SERVER_DIR}Dockerfile.fixture`, SERVER_DIR]);
}

async function startServer() {
  dtry(["rm", "-f", CONTAINER]);
  docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "--network",
    "host",
    "--shm-size=1g",
    "-e",
    `PORT=${PORT}`,
    "-e",
    "MAX_CONCURRENT_BROWSERS=4",
    "-e",
    "SPICA_CDP_EXPOSE=1", // the whole point: an address an observer outside can reach
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
      // The new knob: where in the open response the CONTROL-PLANE-reachable CDP base lives.
      cdpBase: "sessions.0.cdp_url",
    },
  },
  // The "agent": drive the session's work tab to the task URL. Enough to exercise acquire -> drive ->
  // observe -> release with a real browser doing real work behind an extension.
  frontDoor: {
    service: "spica",
    submit: "POST /navigate",
    request: { bodyTemplate: { session_id: "{{session_id}}", url: "{{task}}" } },
  },
  traceSource: { kind: "mlflow", endpoint: "http://unused" },
};

async function main() {
  console.log("▶ images");
  buildImages();
  console.log("▶ starting the session server");
  await startServer();

  const runId = "spica-live-1";
  const tracks = [];
  const frames = [];
  const backend = new ServiceTopologyBackend({
    runtime: {
      id: "docker-local",
      async ensureTopology() {
        return { endpoints: { spica: BASE } };
      },
      async provisionBrowserEnv() {
        throw new Error("must not be called — the session API owns the browser");
      },
      // Deliberately absent: browserCdpBase. A session-acquired browser is not ours to rediscover, so if the
      // live read works it can only be because the acquired target published its own address.
    },
    traceSource: {
      async fetch() {
        return [];
      },
    },
    specFor: () => SPEC,
    newRunId: () => runId,
    recordSink: () => ({
      track: (item) => tracks.push(item),
      frame: (b64) => frames.push(b64),
    }),
  });

  // Poll the live screen while the case runs — the same call GET /runs/:id/screen makes.
  const live = { attempts: 0, hits: 0, firstHitMs: null, bytes: 0 };
  const t0 = Date.now();
  let polling = true;
  const poller = (async () => {
    while (polling) {
      live.attempts += 1;
      const frame = await backend.captureScreen(runId).catch(() => undefined);
      if (frame) {
        live.hits += 1;
        live.bytes = Math.max(live.bytes, frame.length);
        if (live.firstHitMs === null) live.firstHitMs = Date.now() - t0;
      }
      await sleep(120);
    }
  })();

  console.log(`▶ dispatching one case (task = ${TASK_URL})`);
  const job = {
    tenant: "drill",
    runId,
    harness: { id: SPEC.id, version: SPEC.version },
    evalCase: { id: "c1", env: { kind: "browser" }, task: TASK_URL, graders: [], timeoutSec: 120, tags: [] },
  };
  let result;
  try {
    result = await backend.dispatch(job);
  } finally {
    polling = false;
    await poller;
  }
  const elapsed = Date.now() - t0;

  // After release the address is dropped — a live read must stop answering, or the UI would keep showing
  // a dead browser's last frame as if the case were still running.
  const afterRelease = await backend.captureScreen(runId).catch(() => undefined);

  const kinds = {};
  for (const item of tracks) kinds[item.track] = (kinds[item.track] ?? 0) + 1;
  const navs = tracks.filter((t) => t.track === "nav").map((t) => t.entry.url);

  console.log("\n── LIVE (while the case ran) ──────────────────────────────");
  console.log(`  screen polls: ${live.attempts}   frames returned: ${live.hits}   first at +${live.firstHitMs}ms`);
  console.log(`  largest frame: ${Math.round((live.bytes * 3) / 4 / 1024)} KB (base64 PNG)`);
  console.log(
    `  after the case released the session: ${afterRelease ? "STILL ANSWERING (bad)" : "no frame (correct)"}`,
  );

  console.log("\n── REPLAY (sealed after the case) ─────────────────────────");
  console.log(`  screencast frames recorded: ${frames.length}`);
  console.log(`  environment tracks: ${JSON.stringify(kinds)}`);
  console.log(`  navigation: ${navs.join(" -> ") || "(none)"}`);
  console.log(`  case result: ${result.caseId} / ${result.harness}  (elapsed ${elapsed}ms)`);

  const ok =
    live.hits > 0 && !afterRelease && frames.length > 0 && navs.some((u) => u.startsWith(TASK_URL.slice(0, 24)));
  console.log(
    `\n${ok ? "PASS" : "FAIL"} — live=${live.hits > 0} released=${!afterRelease} frames=${frames.length > 0} nav=${navs.length > 0}`,
  );
  return ok ? 0 : 1;
}

main()
  .then(async (code) => {
    dtry(["rm", "-f", CONTAINER]);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("✗", err?.stack ?? err);
    console.error(dtry(["logs", "--tail", "40", CONTAINER]));
    dtry(["rm", "-f", CONTAINER]);
    process.exit(2);
  });
