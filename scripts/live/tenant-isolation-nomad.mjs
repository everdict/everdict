// Live verification: warm topologies are separated per tenant (trust-zone) — no sharing.
//
// ensureTopology of the same harness spec + same version for two tenants (alpha, beta)
// does not share one warm pool; a separate Nomad service job comes up per zone
// (everdict-harness-...-alpha, ...-beta running concurrently). Evaluation is arbitrary code
// execution, so warm processes must not be shared across tenants.
//
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/tenant-isolation-nomad.mjs
//
// Note (honesty): this dev cluster has only runc via the docker runtime and no namespace set,
// so the demo zones use trusted=true (runc allowed) + no namespace. Real untrusted tenants get
// runsc/kata + a dedicated namespace enforced (verified by unit tests; the cluster needs runsc/namespace).

import { NomadTopologyRuntime } from "../../packages/topology/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const FRONTDOOR_IMAGE = process.env.FRONTDOOR_IMAGE ?? "mendhak/http-https-echo:latest";
const STAMP = Date.now().toString(36);
const VERSION = `iso-${STAMP}`;

const SPEC = {
  kind: "service",
  id: "bu",
  version: VERSION,
  services: [{ name: "agent-server", image: FRONTDOOR_IMAGE, port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["url"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://127.0.0.1:5501" },
};

// zone for the dev cluster: runc allowed (trusted) + no namespace. We observe that warm pools are separated by zone.id alone.
const zone = (id) => ({ id, isolationRuntime: "runc", network: "open", trusted: true });

async function harnessJobs() {
  const r = await fetch(`${NOMAD_ADDR}/v1/jobs?prefix=everdict-harness-bu-${VERSION}&namespace=*`);
  const jobs = await r.json();
  return jobs.map((j) => ({ id: j.ID, status: j.Status }));
}

async function main() {
  const runtime = new NomadTopologyRuntime({
    addr: NOMAD_ADDR,
    pollIntervalMs: 1500,
    maxPolls: 80,
    readyTimeoutMs: 60000,
  });

  console.log(`same spec (bu@${VERSION}) for two tenants: alpha, beta\n`);
  const a = await runtime.ensureTopology(SPEC, zone("alpha"));
  console.log("  tenant alpha front-door:", a.endpoints["agent-server"]);
  const b = await runtime.ensureTopology(SPEC, zone("beta"));
  console.log("  tenant beta  front-door:", b.endpoints["agent-server"]);

  const jobs = await harnessJobs();
  console.log("\n=== warm topology jobs on Nomad (same spec+version) ===");
  for (const j of jobs) console.log(`  ${j.id}  [${j.status}]`);

  const shared = a.endpoints["agent-server"] === b.endpoints["agent-server"];
  const distinct = jobs.length >= 2 && new Set(jobs.map((j) => j.id)).size >= 2;
  console.log("\n=== RESULT ===");
  console.log("alpha/beta share the same front-door endpoint?", shared);
  console.log("two distinct warm topology jobs exist?       ", distinct);
  console.log(
    !shared && distinct
      ? "✅ warm pools are per-tenant — NOT shared across tenants"
      : "❌ warm pool appears shared across tenants",
  );

  console.log("\ntearing down both tenants' warm topologies …");
  await runtime.teardown(SPEC, zone("alpha"));
  await runtime.teardown(SPEC, zone("beta"));
  const left = await harnessJobs();
  console.log("remaining warm jobs after teardown:", left.filter((j) => j.status !== "dead").length);
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
