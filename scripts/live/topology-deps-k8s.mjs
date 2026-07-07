// Live: verify on a real kind cluster that K8sTopologyRuntime **deploys spec.dependencies[] (postgres/redis) together with**
// the topology and auto-injects the connection env (DATABASE_URL/REDIS_URL) into the service.
//   ensureTopology(provisionDependencies) → PG+Redis Deployment Ready → front-door Ready + endpoint (HTTP 200)
//   → confirm DATABASE_URL/REDIS_URL (store DNS) in the front-door pod env → confirm PG reachable via that DNS (pg_isready).
//
// Setup: kind cluster 'everdict' + postgres:16-alpine/redis:7-alpine/mendhak/http-https-echo loaded onto the node.
//   kind load docker-image postgres:16-alpine redis:7-alpine mendhak/http-https-echo:latest --name everdict
// Usage: PATH=$HOME/.local/bin:$PATH node scripts/live/topology-deps-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-everdict";
const NS = "everdict-deps-demo";
const kc = (args, input) =>
  execFileSync("kubectl", ["--context", CTX, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// Service topology with store dependencies (postgres+redis) + one HTTP front-door.
const spec = {
  kind: "service",
  id: "deps-demo",
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "mendhak/http-https-echo:latest", port: 8080, needs: [], perRun: [], replicas: 1 },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", isolateBy: "thread_id" },
    { store: "redis", role: "broker", isolateBy: "key-prefix" },
  ],
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};

// kind: preloaded images → IfNotPresent. Zone (tenant) = this demo namespace.
const runtime = new K8sTopologyRuntime({
  context: CTX,
  imagePullPolicy: "IfNotPresent",
  provisionDependencies: true,
  readyTimeoutMs: 120_000,
});
const zone = { id: "deps-demo", namespace: NS, isolationRuntime: "runc", network: "deny-cross-tenant", trusted: true };

console.log(`K8sTopologyRuntime → ensureTopology(provisionDependencies) ns=${NS} …`);
let ok = false;
try {
  const topo = await runtime.ensureTopology(spec, zone);
  console.log("endpoints :", JSON.stringify(topo.endpoints));

  // 1) Did the store Deployments come up?
  const deploys = kc(["-n", NS, "get", "deploy", "-o", "name"]).trim().split("\n").sort();
  console.log("deploys   :", deploys.join(", "));
  const hasPg = deploys.includes("deployment.apps/deps-demo-postgres");
  const hasRedis = deploys.includes("deployment.apps/deps-demo-redis");

  // 2) Did the auto-wired connection URLs make it into the front-door pod env?
  const pod = kc(["-n", NS, "get", "pod", "-l", "app=agent-server", "-o", "jsonpath={.items[0].metadata.name}"]).trim();
  const envDump = kc(["-n", NS, "exec", pod, "--", "env"]);
  const dbUrl = /DATABASE_URL=(.*)/.exec(envDump)?.[1]?.trim() ?? "";
  const redisUrl = /REDIS_URL=(.*)/.exec(envDump)?.[1]?.trim() ?? "";
  console.log("DATABASE_URL:", dbUrl);
  console.log("REDIS_URL :", redisUrl);

  // 3) Is PG actually reachable via that DNS (in-cluster)? pg_isready -h deps-demo-postgres.
  let pgReachable = false;
  try {
    const out = kc([
      "-n",
      NS,
      "run",
      "pg-probe",
      "--image=postgres:16-alpine",
      "--image-pull-policy=IfNotPresent",
      "--restart=Never",
      "--rm",
      "-i",
      "--command",
      "--",
      "pg_isready",
      "-h",
      "deps-demo-postgres",
      "-p",
      "5432",
    ]);
    pgReachable = /accepting connections/.test(out);
    console.log("pg-probe  :", out.trim().split("\n")[0]);
  } catch (e) {
    console.log("pg-probe  : FAILED", (e.stdout ?? e.message ?? "").toString().slice(0, 200));
  }

  const dbOk = dbUrl === "postgresql://everdict:everdict@deps-demo-postgres:5432/everdict";
  const redisOk = redisUrl === "redis://deps-demo-redis:6379";
  ok = hasPg && hasRedis && dbOk && redisOk && pgReachable && Object.keys(topo.endpoints).length === 1;
  console.log(
    `\nchecks: pg-deploy=${hasPg} redis-deploy=${hasRedis} db-env=${dbOk} redis-env=${redisOk} pg-reachable=${pgReachable} frontdoor-endpoint=${Object.keys(topo.endpoints).length === 1}`,
  );
  console.log(
    ok
      ? "\n✅ K8sTopologyRuntime deploys declared dependencies (PG+Redis) together + auto-injects the connection env into the service + real store-DNS connectivity — ready to deploy real OSS stateful harnesses"
      : "\n⚠️ Some checks failed",
  );
} finally {
  await runtime.teardown(spec, zone).catch((e) => console.log("teardown warn:", e.message));
  console.log("teardown  : ns delete requested");
}
process.exit(ok ? 0 : 1);
