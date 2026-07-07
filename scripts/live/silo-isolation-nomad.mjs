// Live: Nomad silo store isolation (tenant-dedicated instance). NomadTopologyRuntime launches a **separate dedicated PG job**
// per zone, discovers host:port, and wires it into the service connEnv (same discover-then-inject as pool, no DDL). Silo
// isolation = a physically separate instance. Proof: two zones → distinct dedicated PG jobs (different host:port), each PG reachable.
//
// Setup: `nomad agent -dev` (docker driver) + postgres:16-alpine on host docker.
// Usage: PATH=$HOME/.local/bin:$PATH NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/silo-isolation-nomad.mjs
import net from "node:net";
import process from "node:process";
import { NomadTopologyRuntime, dedicatedStoreJobId, topologyJobId } from "../../packages/topology/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";

const spec = {
  kind: "service",
  id: "silo-nomad",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "mendhak/http-https-echo:latest", needs: [], perRun: [], replicas: 1 }],
  dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
// trusted:false → derives silo (dedicated instance). namespace unset = default.
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  network: "deny-cross-tenant",
  trusted: false,
  storeIsolation: "silo",
});

const rt = new NomadTopologyRuntime({ addr: ADDR, datacenters: ["dc1"], pollIntervalMs: 2000, maxPolls: 60 });

// Read the topology job's service env (DATABASE_URL).
const serviceDbUrl = async (zoneId) => {
  const res = await fetch(`${ADDR}/v1/job/${topologyJobId(spec, zoneId)}`);
  const job = await res.json();
  const env = job.TaskGroups?.[0]?.Tasks?.[0]?.Env ?? {};
  return env.DATABASE_URL ?? "";
};
const jobExists = async (id) => (await fetch(`${ADDR}/v1/job/${id}`)).status === 200;
// Confirm TCP connectivity to the dedicated PG's host-mapped dynamic port (retry while initdb comes up). DATABASE_URL=...@127.0.0.1:<port>/...
const tcpOk = (host, port) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
const pgReachable = async (url) => {
  const m = /@([\d.]+):(\d+)\//.exec(url);
  if (!m) return false;
  for (let i = 0; i < 20; i++) {
    if (await tcpOk(m[1], Number(m[2]))) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
};

console.log("Nomad silo store isolation — dedicated PG instance per zone (separate host:port), each reachable\n");
let ok = false;
try {
  await rt.ensureTopology(spec, zone("acme"));
  await rt.ensureTopology(spec, zone("globex"));

  const acmeJob = await jobExists(dedicatedStoreJobId(spec, "acme"));
  const globexJob = await jobExists(dedicatedStoreJobId(spec, "globex"));
  const acmeUrl = await serviceDbUrl("acme");
  const globexUrl = await serviceDbUrl("globex");
  const distinct = acmeUrl !== "" && globexUrl !== "" && acmeUrl !== globexUrl; // different instance host:port
  const acmeReady = await pgReachable(acmeUrl);
  const globexReady = await pgReachable(globexUrl);

  console.log(`dedicated PG jobs : acme=${acmeJob} globex=${globexJob}`);
  console.log(`acme  service DATABASE_URL: ${acmeUrl}`);
  console.log(`globex service DATABASE_URL: ${globexUrl}`);
  console.log(`distinct instances(different host:port): ${distinct}`);
  console.log(`PG reachable     : acme=${acmeReady} globex=${globexReady}`);

  ok = acmeJob && globexJob && distinct && acmeReady && globexReady;
  console.log(
    ok
      ? "\n✅ Nomad silo: deploy a dedicated PG instance per zone (separate host:port) + inject the discovered endpoint into the service + each reachable. Physical isolation. K8s↔Nomad silo parity → store-isolation matrix complete (pool+silo, both orchestrators)."
      : "\n⚠️ Some checks failed",
  );
} finally {
  await rt.teardown(spec, zone("acme")).catch(() => {});
  await rt.teardown(spec, zone("globex")).catch(() => {});
  console.log("teardown: purge requested for topology + dedicated store jobs");
}
process.exit(ok ? 0 : 1);
