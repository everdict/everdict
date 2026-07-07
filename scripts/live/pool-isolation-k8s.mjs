// Live: pool store isolation (multi-tenant SaaS). K8sTopologyRuntime mints a per-tenant dedicated
// DB+role on **one shared PG** and injects scoped creds into the service. Core proof: **tenant A's creds connecting to
// tenant B's DB → refused (DENIED)**, its own DB → allowed. (Live proof that the tenant boundary is DB/role/creds, not isolateBy.)
//   ensureTopology(zone, storeIsolation:pool) → deploy everdict-shared-postgres once → CREATE DATABASE tenant_x +
//   CREATE ROLE r_x + REVOKE CONNECT FROM PUBLIC → service env=DATABASE_URL(tenant_x/r_x) → verify cross-connect refusal.
//
// Prereqs: kind 'everdict' + postgres:16-alpine/mendhak/http-https-echo node images loaded.
// Usage: PATH=$HOME/.local/bin:$PATH node scripts/live/pool-isolation-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime, planTenantStores } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-everdict";
const POOL_NS = "everdict-shared";
const kc = (args, input) =>
  execFileSync("kubectl", ["--context", CTX, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

const spec = {
  kind: "service",
  id: "pool-demo",
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "mendhak/http-https-echo:latest", port: 8080, needs: [], perRun: [], replicas: 1 },
  ],
  dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
// trusted=true + storeIsolation:pool — first-party/semi-trusted tenants (shared infra + logical isolation).
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `everdict-pool-${id}`,
  network: "deny-cross-tenant",
  trusted: true,
  storeIsolation: "pool",
});

const runtime = new K8sTopologyRuntime({
  context: CTX,
  imagePullPolicy: "IfNotPresent",
  poolNamespace: POOL_NS,
  readyTimeoutMs: 120_000,
});

// Run psql from the pg pod with an arbitrary connection URL → decide success/failure (refusal).
const pgPod = () =>
  kc([
    "-n",
    POOL_NS,
    "get",
    "pod",
    "-l",
    "app=everdict-shared-postgres",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ]).trim();
const tryConnect = (url) => {
  try {
    kc(["-n", POOL_NS, "exec", "-i", pgPod(), "--", "psql", url, "-tAc", "select 1"]);
    return "OK";
  } catch (e) {
    const msg = (e.stderr ?? e.stdout ?? e.message ?? "").toString();
    return /permission denied|not permitted|no pg_hba|password authentication failed/i.test(msg)
      ? "DENIED"
      : `ERR(${msg.split("\n")[0]?.slice(0, 80)})`;
  }
};

console.log("pool multi-tenant store isolation — shared PG + per-tenant DB/role, verify cross-connect refusal\n");
let ok = false;
try {
  await runtime.ensureTopology(spec, zone("acme"));
  await runtime.ensureTopology(spec, zone("globex"));

  // Did both tenant DBs get created on the shared store?
  const dbs = kc([
    "-n",
    POOL_NS,
    "exec",
    "-i",
    pgPod(),
    "--",
    "psql",
    "-U",
    "everdict",
    "-tAc",
    "SELECT datname FROM pg_database",
  ]);
  const hasAcme = /tenant_acme/.test(dbs);
  const hasGlobex = /tenant_globex/.test(dbs);
  console.log(
    "shared PG databases:",
    dbs
      .trim()
      .split("\n")
      .filter((d) => d.startsWith("tenant_"))
      .join(", "),
  );

  // Both tenants' scoped connection URLs (same as what the runtime injects into the service — same plan).
  const acme = planTenantStores(spec, zone("acme"), { poolNamespace: POOL_NS }).serviceEnv.DATABASE_URL;
  const globex = planTenantStores(spec, zone("globex"), { poolNamespace: POOL_NS }).serviceEnv.DATABASE_URL;
  // Since we connect from inside the pg pod, rewrite the host to localhost (same container). Only DB/role/password are under test.
  const local = (u) => u.replace("everdict-shared-postgres.everdict-shared.svc.cluster.local", "127.0.0.1");
  const acmeToGlobex = local(acme).replace("/tenant_acme", "/tenant_globex"); // acme creds → globex DB

  const ownAcme = tryConnect(local(acme));
  const ownGlobex = tryConnect(local(globex));
  const cross = tryConnect(acmeToGlobex);
  console.log(`\nacme creds → tenant_acme  : ${ownAcme}`);
  console.log(`globex creds → tenant_globex: ${ownGlobex}`);
  console.log(`acme creds → tenant_globex : ${cross}   <-- cross-connect (must be refused)`);

  ok = hasAcme && hasGlobex && ownAcme === "OK" && ownGlobex === "OK" && cross === "DENIED";
  console.log(
    `\nchecks: acme-db=${hasAcme} globex-db=${hasGlobex} own-acme=${ownAcme === "OK"} own-globex=${ownGlobex === "OK"} cross-denied=${cross === "DENIED"}`,
  );
  console.log(
    ok
      ? "\n✅ pool multi-tenant: one shared PG + per-tenant DB/role/creds — tenant A's creds refused on tenant B's DB, only its own DB allowed. (shared infra with minimal management for performance + trust-zone logical isolation)"
      : "\n⚠️ some checks failed",
  );
} finally {
  await runtime.teardown(spec, zone("acme")).catch(() => {});
  await runtime.teardown(spec, zone("globex")).catch(() => {});
  // Clean up the shared store ns too (demo).
  kc(["delete", "ns", POOL_NS, "--ignore-not-found", "--wait=false"]);
  console.log("teardown: requested deletion of zone ns + shared-store ns");
}
process.exit(ok ? 0 : 1);
