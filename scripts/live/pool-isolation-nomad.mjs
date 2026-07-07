// Live: pool store isolation on Nomad (multi-tenant). NomadTopologyRuntime brings up **one shared PG** (a Nomad service job)
// and discovers its host:port → mints a per-tenant dedicated DB+role via `nomad alloc exec` → injects scoped creds into the service.
// Core proof (same as K8s SLICE 40): tenant A's creds connecting to tenant B's DB → refused (DENIED), its own DB → allowed.
// (Nomad has no DNS without Consul, so unlike K8s the runtime discovers the alloc host:port and injects it.)
//
// Prereqs: `nomad agent -dev` (docker driver) + postgres:16-alpine present in the host docker.
// Usage: PATH=$HOME/.local/bin:$PATH NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/pool-isolation-nomad.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { NomadTopologyRuntime, SHARED_STORE_JOB_ID, planTenantStores } from "../../packages/topology/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const nomad = (args, input) =>
  execFileSync("nomad", args, { input, encoding: "utf8", env: { ...process.env, NOMAD_ADDR: ADDR } });

// Service with no port → skip the endpoint-discovery loop (here we only verify pool store isolation). Depends on postgres.
const spec = {
  kind: "service",
  id: "pool-nomad",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "mendhak/http-https-echo:latest", needs: [], perRun: [], replicas: 1 }],
  dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  network: "deny-cross-tenant",
  trusted: true,
  storeIsolation: "pool",
});

const rt = new NomadTopologyRuntime({ addr: ADDR, datacenters: ["dc1"], pollIntervalMs: 2000, maxPolls: 60 });

// Discover the shared PG alloc id (to run the tenant-verification psql inside the alloc).
const sharedPgAlloc = async () => {
  const res = await fetch(`${ADDR}/v1/job/${SHARED_STORE_JOB_ID}/allocations`);
  const allocs = await res.json();
  return allocs.find((a) => a.TaskGroup === "everdict-shared-postgres" && a.ClientStatus === "running")?.ID;
};
// Attempt to connect via the psql URL inside the alloc → OK/DENIED.
const tryConnect = (allocId, url) => {
  try {
    nomad(["alloc", "exec", "-task", "everdict-shared-postgres", allocId, "psql", url, "-tAc", "select 1"]);
    return "OK";
  } catch (e) {
    const msg = (e.stderr ?? e.stdout ?? e.message ?? "").toString();
    return /permission denied|not permitted|authentication failed|no pg_hba/i.test(msg)
      ? "DENIED"
      : `ERR(${msg.split("\n")[0]?.slice(0, 70)})`;
  }
};

console.log("Nomad pool multi-tenant store isolation — shared PG + per-tenant DB/role, verify cross-connect refusal\n");
let ok = false;
try {
  await rt.ensureTopology(spec, zone("acme")); // deploy shared PG + mint tenant_acme/r_acme
  await rt.ensureTopology(spec, zone("globex")); // mint tenant_globex/r_globex (reuse shared PG)

  const allocId = await sharedPgAlloc();
  if (!allocId) throw new Error("could not find the shared PG alloc");
  // Since we connect from inside the alloc, use localhost:5432. Only DB/role/password are under test (= same plan the runtime injects).
  const creds = (id) =>
    planTenantStores(spec, zone(id), { storeEndpoint: () => "127.0.0.1:5432" }).serviceEnv.DATABASE_URL;
  const acme = creds("acme");
  const globex = creds("globex");
  const acmeToGlobex = acme.replace("/tenant_acme", "/tenant_globex"); // acme creds → globex DB

  // Did both tenant DBs get created on the shared PG?
  const dbs = nomad([
    "alloc",
    "exec",
    "-task",
    "everdict-shared-postgres",
    allocId,
    "psql",
    "-U",
    "everdict",
    "-tAc",
    "SELECT datname FROM pg_database",
  ]);
  console.log(
    "shared PG databases:",
    dbs
      .trim()
      .split("\n")
      .filter((d) => d.startsWith("tenant_"))
      .join(", "),
  );

  const ownAcme = tryConnect(allocId, acme);
  const ownGlobex = tryConnect(allocId, globex);
  const cross = tryConnect(allocId, acmeToGlobex);
  console.log(`\nacme creds → tenant_acme   : ${ownAcme}`);
  console.log(`globex creds → tenant_globex: ${ownGlobex}`);
  console.log(`acme creds → tenant_globex : ${cross}   <-- cross-connect (must be refused)`);

  ok =
    /tenant_acme/.test(dbs) &&
    /tenant_globex/.test(dbs) &&
    ownAcme === "OK" &&
    ownGlobex === "OK" &&
    cross === "DENIED";
  console.log(
    `\nchecks: own-acme=${ownAcme === "OK"} own-globex=${ownGlobex === "OK"} cross-denied=${cross === "DENIED"}`,
  );
  console.log(
    ok
      ? "\n✅ Nomad pool multi-tenant: one shared PG + per-tenant DB/role/creds — tenant A's creds refused on tenant B's DB, only its own DB allowed. K8s↔Nomad pool isolation parity."
      : "\n⚠️ some checks failed",
  );
} finally {
  await rt.teardown(spec, zone("acme")).catch(() => {});
  await rt.teardown(spec, zone("globex")).catch(() => {});
  try {
    nomad(["job", "stop", "-purge", SHARED_STORE_JOB_ID]);
  } catch {}
  console.log("teardown: requested purge of topology/shared-store jobs");
}
process.exit(ok ? 0 : 1);
