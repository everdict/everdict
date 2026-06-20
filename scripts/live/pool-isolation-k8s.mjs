// 라이브: pool 스토어 격리(멀티테넌트 SaaS). K8sTopologyRuntime 이 **공유 PG 1대**에 테넌트별 전용
// DB+role 을 mint 하고, 서비스에 scoped creds 를 주입한다. 핵심 증명: **테넌트 A 자격증명으로 테넌트 B
// DB 접속 → 거부(DENIED)**, 자기 DB → 허용. (isolateBy 가 아니라 DB/role/creds 가 테넌트 경계임을 라이브로.)
//   ensureTopology(zone, storeIsolation:pool) → assay-shared-postgres 1회 배포 → CREATE DATABASE tenant_x +
//   CREATE ROLE r_x + REVOKE CONNECT FROM PUBLIC → 서비스 env=DATABASE_URL(tenant_x/r_x) → 교차접속 거부 검증.
//
// 준비: kind 'assay' + postgres:16-alpine/mendhak/http-https-echo 노드 로드.
// 사용: PATH=$HOME/.local/bin:$PATH node scripts/live/pool-isolation-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime, planTenantStores } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-assay";
const POOL_NS = "assay-shared";
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
// trusted=true + storeIsolation:pool — first-party/semi-trusted 테넌트(공유 인프라 + 논리격리).
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `assay-pool-${id}`,
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

// pg pod 에서 임의 접속 URL 로 psql 실행 → 성공/실패(거부) 판정.
const pgPod = () =>
  kc([
    "-n",
    POOL_NS,
    "get",
    "pod",
    "-l",
    "app=assay-shared-postgres",
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

console.log("pool 멀티테넌트 스토어 격리 — 공유 PG + 테넌트별 DB/role, 교차접속 거부 검증\n");
let ok = false;
try {
  await runtime.ensureTopology(spec, zone("acme"));
  await runtime.ensureTopology(spec, zone("globex"));

  // 공유 스토어에 두 테넌트 DB 가 생겼나.
  const dbs = kc([
    "-n",
    POOL_NS,
    "exec",
    "-i",
    pgPod(),
    "--",
    "psql",
    "-U",
    "assay",
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

  // 두 테넌트의 scoped 접속 URL(런타임이 서비스에 주입하는 것과 동일 — 동일 plan).
  const acme = planTenantStores(spec, zone("acme"), { poolNamespace: POOL_NS }).serviceEnv.DATABASE_URL;
  const globex = planTenantStores(spec, zone("globex"), { poolNamespace: POOL_NS }).serviceEnv.DATABASE_URL;
  // pg pod 안에서 접속하므로 호스트는 localhost 로(같은 컨테이너). DB/role/비번만 검증 대상.
  const local = (u) => u.replace("assay-shared-postgres.assay-shared.svc.cluster.local", "127.0.0.1");
  const acmeToGlobex = local(acme).replace("/tenant_acme", "/tenant_globex"); // acme creds → globex DB

  const ownAcme = tryConnect(local(acme));
  const ownGlobex = tryConnect(local(globex));
  const cross = tryConnect(acmeToGlobex);
  console.log(`\nacme creds → tenant_acme  : ${ownAcme}`);
  console.log(`globex creds → tenant_globex: ${ownGlobex}`);
  console.log(`acme creds → tenant_globex : ${cross}   <-- 교차접속(거부돼야 함)`);

  ok = hasAcme && hasGlobex && ownAcme === "OK" && ownGlobex === "OK" && cross === "DENIED";
  console.log(
    `\nchecks: acme-db=${hasAcme} globex-db=${hasGlobex} own-acme=${ownAcme === "OK"} own-globex=${ownGlobex === "OK"} cross-denied=${cross === "DENIED"}`,
  );
  console.log(
    ok
      ? "\n✅ pool 멀티테넌트: 공유 PG 1대 + 테넌트별 DB/role/creds — 테넌트 A 자격증명으로 B DB 접속 거부, 자기 DB 만 허용. (성능 위해 공유 인프라 최소 관리 + trust-zone 논리격리)"
      : "\n⚠️ 일부 체크 실패",
  );
} finally {
  await runtime.teardown(spec, zone("acme")).catch(() => {});
  await runtime.teardown(spec, zone("globex")).catch(() => {});
  // 공유 스토어 ns 도 정리(데모).
  kc(["delete", "ns", POOL_NS, "--ignore-not-found", "--wait=false"]);
  console.log("teardown: zone ns + 공유스토어 ns 삭제 요청됨");
}
process.exit(ok ? 0 : 1);
