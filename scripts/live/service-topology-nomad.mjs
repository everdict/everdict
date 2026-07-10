// Live verification: run the service-topology harness on a real Nomad cluster.
//
// What is "real":
//  - warm topology: deploy the front-door service (stand-in) as a Nomad SERVICE job → discover host:port from the alloc
//  - per-case target env: launch headless Chromium on Nomad and discover the real CDP endpoint (/json/version)
//  - drive: real network POST /runs to the discovered front-door (per-run wiring injected) — verified via alloc logs
//  - trace: fetch the trace from real MLflow (REST) (degrades to an empty trace on auth failure / absence)
//  - grade: score from the real browser snapshot + trace → CaseResult → teardown
//
// What is a stand-in (Phase 2 needs real images):
//  - front-door = mendhak/http-https-echo (substitutes for the browser-use agent-server; logs requests to stdout)
//  - browser client extension (--load-extension; headful) not applied
//
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/service-topology-nomad.mjs

// Workspace package names don't resolve from scripts/, so import the built dist directly
// (each package's @everdict/* deps resolve within the package via pnpm symlinks).
import {
  NomadTopologyRuntime,
  ServiceTopologyBackend,
  buildBrowserJob,
  buildNomadTopologyJob,
  keysFor,
} from "../../packages/topology/dist/index.js";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const MLFLOW_ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const FRONTDOOR_IMAGE = process.env.FRONTDOOR_IMAGE ?? "mendhak/http-https-echo:latest";
const BROWSER_IMAGE = process.env.BROWSER_IMAGE ?? "chromedp/headless-shell:latest";
// docker bridge gateway: the route from an alloc container to the host's shared store (for injection demo).
const HOST_GW = process.env.HOST_GW ?? "172.17.0.1";

/** @type {import("@everdict/contracts").ServiceHarnessSpec} */
const SPEC = {
  kind: "service",
  id: "browser-use-langgraph",
  version: "live-nomad",
  services: [
    {
      name: "agent-server",
      image: FRONTDOOR_IMAGE,
      port: 8080,
      needs: ["postgres", "redis", "browser-mcp"],
      perRun: ["thread_id", "stream_channel", "minio_prefix", "browser_cdp_url"],
      replicas: 1,
    },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", isolateBy: "thread_id" },
    { store: "redis", role: "action-stream", isolateBy: "key-prefix" },
    { store: "minio", role: "snapshots", isolateBy: "object-prefix" },
  ],
  target: {
    kind: "browser",
    engine: "chromium",
    lifecycle: "per-case-instance",
    observe: ["dom", "url"],
  },
  frontDoor: { service: "agent-server", submit: "POST /runs", trace: "GET /runs/{id}/events" },
  traceSource: { kind: "mlflow", endpoint: MLFLOW_ENDPOINT },
};

/** @type {import("@everdict/contracts").AgentJob} */
const JOB = {
  harness: { id: SPEC.id, version: SPEC.version },
  evalCase: {
    id: "svc-topo-live-1",
    env: { kind: "browser", startUrl: "about:blank" },
    task: "open the dashboard and confirm it loads",
    // Score from the real browser snapshot + trace (url-matches/dom-contains = browser, steps = trace).
    graders: [
      { id: "url-matches", config: { pattern: "about:blank" } },
      { id: "dom-contains", config: { text: "about:blank" } },
      { id: "steps" },
    ],
    timeoutSec: 120,
    tags: ["live", "nomad", "service-topology"],
  },
};

function banner(s) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  banner("rendered Nomad specs (what gets applied)");
  console.log(
    "topology job:",
    JSON.stringify(buildNomadTopologyJob(SPEC, { storeEnv: storeEnv() }).Job.TaskGroups[0].Networks),
  );
  console.log("browser job id:", buildBrowserJob(SPEC, "RUNID").Job.ID);

  const runtime = new NomadTopologyRuntime({
    addr: NOMAD_ADDR,
    browserImage: BROWSER_IMAGE,
    storeEnv: storeEnv(),
    pollIntervalMs: 1500,
    maxPolls: 120,
    readyTimeoutMs: 90_000,
  });

  // Wrap submit to verify the per-run wiring actually reached the front-door.
  const delivered = [];
  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource: new MlflowTraceSource({ endpoint: MLFLOW_ENDPOINT }),
    specFor: () => SPEC,
    submit: async (url, payload) => {
      delivered.push({ url, payload });
      console.log(`  → POST ${url}`);
      console.log(`    payload: ${JSON.stringify(payload)}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`    front-door responded: HTTP ${res.status}`);
    },
  });

  banner("dispatch (ensure topology → per-case browser → drive → trace → grade)");
  const started = Date.now();
  let result;
  try {
    result = await backend.dispatch(JOB);
  } finally {
    banner("teardown");
    await runtime.teardown(SPEC).catch((e) => console.log("  topology teardown:", e.message));
    console.log("  warm topology + per-case browser deregistered (purge=true)");
  }

  banner("RESULT");
  console.log("caseId  :", result.caseId);
  console.log("harness :", result.harness);
  console.log("snapshot:", JSON.stringify(result.snapshot));
  console.log("trace   :", result.trace.length, "events (from real MLflow)");
  console.log("scores  :");
  for (const s of result.scores) {
    console.log(`  - ${s.graderId}: pass=${s.pass} value=${s.value}${s.detail ? ` (${s.detail})` : ""}`);
  }
  console.log("elapsed :", ((Date.now() - started) / 1000).toFixed(1), "s");

  banner("per-run wiring delivered over the network");
  const wiring = delivered[0]?.payload ?? {};
  const expected = keysFor(wiring.thread_id?.replace(/^run-/, "") ?? "");
  console.log("thread_id     :", wiring.thread_id);
  console.log("stream_channel:", wiring.stream_channel);
  console.log("minio_prefix  :", wiring.minio_prefix);
  console.log("browser_cdp_url:", wiring.browser_cdp_url);
  console.log("derived-keys consistent:", wiring.minio_prefix === expected.minioPrefix);
}

function storeEnv() {
  return {
    PG_URL: `postgresql://everdict@${HOST_GW}:55433/everdict`,
    REDIS_URL: `redis://${HOST_GW}:6379`,
    MINIO_ENDPOINT: `http://${HOST_GW}:9100`,
  };
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
