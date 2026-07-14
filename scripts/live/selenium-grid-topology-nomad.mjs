// Live proof: a REAL open-source multi-service topology — Selenium Grid (official images) — deployed as an Everdict
// Nomad topology, with genuine inter-service communication (the node registers with the hub over the event bus).
//
// This is the canonical Windows+Ubuntu open-source topology; here both run on Linux (co-located) so it boots in the
// sandbox. It exercises: buildNomadTopologyJob (co-located path), TopologyService.wiring injecting the hub's address
// under Selenium's OWN env name (SE_EVENT_BUS_HOST) into an UNMODIFIED official image, and real service registration.
//
// Prereqs: nomad+consul dev with docker; `pnpm -F @everdict/topology build`.
// Run:  node scripts/live/selenium-grid-topology-nomad.mjs

import { execFileSync } from "node:child_process";
import { buildNomadTopologyJob } from "../../packages/topology/dist/deploy/nomad-topology.js";

const N = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, b) => {
  const r = await fetch(`${N}${p}`, {
    method: m,
    body: b ? JSON.stringify(b) : undefined,
    headers: b ? { "content-type": "application/json" } : undefined,
  });
  return { status: r.status, text: await r.text() };
};
const j = async (p) => JSON.parse((await api("GET", p)).text);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => {
  console.error(`  \x1b[31m✗ ${m}\x1b[0m`);
  process.exitCode = 1;
};

const V = "4.27.0";
const spec = {
  kind: "service",
  id: "selenium",
  version: "1.0.0",
  services: [
    { name: "hub", image: `selenium/hub:${V}`, port: 4444, needs: [], perRun: [], replicas: 1, env: {} },
    {
      name: "node",
      image: `selenium/node-chromium:${V}`,
      needs: ["hub"],
      perRun: [],
      replicas: 1,
      // Selenium's fixed event-bus ports (static). The HOST of the hub is injected below via wiring.
      env: { SE_EVENT_BUS_PUBLISH_PORT: "4442", SE_EVENT_BUS_SUBSCRIBE_PORT: "4443", SE_NODE_MAX_SESSIONS: "1" },
      // wiring: inject the hub's address under Selenium's OWN env name into the unmodified official image.
      wiring: [{ service: "hub", hostEnv: "SE_EVENT_BUS_HOST" }],
    },
  ],
  dependencies: [],
  frontDoor: { service: "hub", submit: "POST /session" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};

async function main() {
  console.log("\n\x1b[1mReal Selenium Grid (official images) as an Everdict Nomad topology\x1b[0m");
  if ((await api("GET", "/v1/agent/self")).status !== 200) throw new Error(`Nomad not reachable at ${N}`);

  const job = buildNomadTopologyJob(spec, { datacenters: ["dc1"] });
  const nodeTask = job.Job.TaskGroups[0]?.Tasks.find((t) => t.Name === "node");
  console.log("\n1) Builder + wiring");
  nodeTask?.Env.SE_EVENT_BUS_HOST === "hub"
    ? ok("wiring injected SE_EVENT_BUS_HOST=hub into the unmodified selenium/node image")
    : fail(`SE_EVENT_BUS_HOST not injected (got ${nodeTask?.Env.SE_EVENT_BUS_HOST})`);

  console.log("\n2) Submit + wait for the grid to boot (pulls ~1GB images — be patient)");
  await api("DELETE", `/v1/job/${job.Job.ID}?purge=true`);
  const sub = await api("POST", "/v1/jobs", { Job: job.Job });
  sub.status === 200 ? ok("submitted") : fail(`submit failed: ${sub.status} ${sub.text}`);

  let alloc;
  for (let i = 0; i < 150; i++) {
    const allocs = await j(`/v1/job/${job.Job.ID}/allocations`);
    alloc = allocs[0];
    const states = alloc?.TaskStates ?? {};
    if (alloc?.ClientStatus === "running" && states.hub?.State === "running" && states.node?.State === "running") break;
    if (alloc?.ClientStatus === "failed") {
      fail(`alloc failed: ${JSON.stringify(states)}`);
      break;
    }
    await sleep(4000);
  }
  alloc?.ClientStatus === "running"
    ? ok("co-located alloc running (hub + node tasks)")
    : fail(`grid not running (${alloc?.ClientStatus})`);

  if (alloc?.ClientStatus === "running") {
    console.log("\n3) Real inter-service communication — the node registered with the hub");
    let registered = false;
    for (let i = 0; i < 30; i++) {
      try {
        const out = execFileSync(
          "nomad",
          ["alloc", "exec", "-task", "hub", alloc.ID, "curl", "-s", "http://localhost:4444/status"],
          {
            encoding: "utf8",
            timeout: 20000,
            env: { ...process.env, NOMAD_ADDR: N },
          },
        );
        const status = JSON.parse(out.slice(out.indexOf("{")));
        const nodes = status.value?.nodes ?? [];
        if (status.value?.ready && nodes.length >= 1) {
          console.log(
            `     hub /status: ready=${status.value.ready}, nodes=${nodes.length}, node availability=${nodes[0]?.availability}`,
          );
          registered = true;
          break;
        }
      } catch {
        // hub not answering yet / curl absent — retry
      }
      await sleep(4000);
    }
    registered
      ? ok("the Selenium node connected to the hub's event bus and registered — real multi-service topology working")
      : fail("the node did not register with the hub within the deadline");
  }

  console.log("\n4) Cleanup");
  await api("DELETE", `/v1/job/${job.Job.ID}?purge=true`);
  ok("purged");
  console.log(
    process.exitCode
      ? "\n\x1b[31mFAILED\x1b[0m"
      : "\n\x1b[32mALL CHECKS PASSED — real Selenium Grid ran as an Everdict topology, node↔hub verified\x1b[0m",
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
