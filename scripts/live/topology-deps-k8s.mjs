// 라이브: K8sTopologyRuntime 가 spec.dependencies[](postgres/redis)를 토폴로지와 **함께 배포**하고
// 서비스에 접속 env(DATABASE_URL/REDIS_URL)를 자동 주입하는지 실제 kind 클러스터에서 검증한다.
//   ensureTopology(provisionDependencies) → PG+Redis Deployment Ready → front-door Ready + endpoint(HTTP 200)
//   → front-door 파드 env 에 DATABASE_URL/REDIS_URL(스토어 DNS) 확인 → PG 를 그 DNS 로 접속(pg_isready) 확인.
//
// 준비: kind 클러스터 'assay' + postgres:16-alpine/redis:7-alpine/mendhak/http-https-echo 가 노드에 로드돼 있어야 함.
//   kind load docker-image postgres:16-alpine redis:7-alpine mendhak/http-https-echo:latest --name assay
// 사용: PATH=$HOME/.local/bin:$PATH node scripts/live/topology-deps-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-assay";
const NS = "assay-deps-demo";
const kc = (args, input) =>
  execFileSync("kubectl", ["--context", CTX, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// 스토어 의존(postgres+redis) + HTTP front-door 1개인 service 토폴로지.
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

// kind: 사전 로드 이미지 → IfNotPresent. 존(테넌트) = 이 데모 네임스페이스.
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

  // 1) 스토어 Deployment 가 떴나.
  const deploys = kc(["-n", NS, "get", "deploy", "-o", "name"]).trim().split("\n").sort();
  console.log("deploys   :", deploys.join(", "));
  const hasPg = deploys.includes("deployment.apps/deps-demo-postgres");
  const hasRedis = deploys.includes("deployment.apps/deps-demo-redis");

  // 2) front-door 파드 env 에 자동 와이어링된 접속 URL 이 들어갔나.
  const pod = kc(["-n", NS, "get", "pod", "-l", "app=agent-server", "-o", "jsonpath={.items[0].metadata.name}"]).trim();
  const envDump = kc(["-n", NS, "exec", pod, "--", "env"]);
  const dbUrl = /DATABASE_URL=(.*)/.exec(envDump)?.[1]?.trim() ?? "";
  const redisUrl = /REDIS_URL=(.*)/.exec(envDump)?.[1]?.trim() ?? "";
  console.log("DATABASE_URL:", dbUrl);
  console.log("REDIS_URL :", redisUrl);

  // 3) 그 DNS 로 PG 가 실제 접속되나(in-cluster). pg_isready -h deps-demo-postgres.
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

  const dbOk = dbUrl === "postgresql://assay:assay@deps-demo-postgres:5432/assay";
  const redisOk = redisUrl === "redis://deps-demo-redis:6379";
  ok = hasPg && hasRedis && dbOk && redisOk && pgReachable && Object.keys(topo.endpoints).length === 1;
  console.log(
    `\nchecks: pg-deploy=${hasPg} redis-deploy=${hasRedis} db-env=${dbOk} redis-env=${redisOk} pg-reachable=${pgReachable} frontdoor-endpoint=${Object.keys(topo.endpoints).length === 1}`,
  );
  console.log(
    ok
      ? "\n✅ K8sTopologyRuntime 가 declared dependencies(PG+Redis)를 함께 배포 + 서비스에 접속 env 자동 주입 + 스토어 DNS 실접속 — 실 OSS 스테이트풀 하니스 배포 준비 완료"
      : "\n⚠️ 일부 체크 실패",
  );
} finally {
  await runtime.teardown(spec, zone).catch((e) => console.log("teardown warn:", e.message));
  console.log("teardown  : ns 삭제 요청됨");
}
process.exit(ok ? 0 : 1);
