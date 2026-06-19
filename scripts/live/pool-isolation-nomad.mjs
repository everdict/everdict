// 라이브: Nomad 에서 pool 스토어 격리(멀티테넌트). NomadTopologyRuntime 이 **공유 PG 1개**(Nomad service 잡)를
// 띄우고 host:port 를 발견 → 테넌트별 전용 DB+role 을 `nomad alloc exec` 로 mint → 서비스에 scoped creds 주입.
// 핵심 증명(K8s SLICE 40 과 동일): 테넌트 A creds 로 테넌트 B DB 접속 → 거부(DENIED), 자기 DB → 허용.
// (Nomad 는 Consul 없이 DNS 가 없어 K8s 와 달리 런타임이 alloc host:port 를 발견해 주입한다.)
//
// 준비: `nomad agent -dev`(docker driver) + postgres:16-alpine 가 호스트 docker 에 있어야 함.
// 사용: PATH=$HOME/.local/bin:$PATH NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/pool-isolation-nomad.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { NomadTopologyRuntime, SHARED_STORE_JOB_ID, planTenantStores } from "../../packages/topology/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const nomad = (args, input) =>
  execFileSync("nomad", args, { input, encoding: "utf8", env: { ...process.env, NOMAD_ADDR: ADDR } });

// 포트 없는 서비스 → 엔드포인트 발견 루프 skip(여기선 pool 스토어 격리만 검증). postgres 의존.
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

// 공유 PG alloc id 발견(테넌트 검증 psql 을 alloc 안에서 돌리기 위함).
const sharedPgAlloc = async () => {
  const res = await fetch(`${ADDR}/v1/job/${SHARED_STORE_JOB_ID}/allocations`);
  const allocs = await res.json();
  return allocs.find((a) => a.TaskGroup === "assay-shared-postgres" && a.ClientStatus === "running")?.ID;
};
// alloc 안에서 psql URL 로 접속 시도 → OK/DENIED.
const tryConnect = (allocId, url) => {
  try {
    nomad(["alloc", "exec", "-task", "assay-shared-postgres", allocId, "psql", url, "-tAc", "select 1"]);
    return "OK";
  } catch (e) {
    const msg = (e.stderr ?? e.stdout ?? e.message ?? "").toString();
    return /permission denied|not permitted|authentication failed|no pg_hba/i.test(msg)
      ? "DENIED"
      : `ERR(${msg.split("\n")[0]?.slice(0, 70)})`;
  }
};

console.log("Nomad pool 멀티테넌트 스토어 격리 — 공유 PG + 테넌트별 DB/role, 교차접속 거부 검증\n");
let ok = false;
try {
  await rt.ensureTopology(spec, zone("acme")); // 공유 PG 배포 + tenant_acme/r_acme mint
  await rt.ensureTopology(spec, zone("globex")); // tenant_globex/r_globex mint(공유 PG 재사용)

  const allocId = await sharedPgAlloc();
  if (!allocId) throw new Error("공유 PG alloc 을 찾지 못함");
  // alloc 안에서 접속하므로 localhost:5432. DB/role/비번만 검증 대상(=런타임이 주입한 것과 동일 plan).
  const creds = (id) =>
    planTenantStores(spec, zone(id), { storeEndpoint: () => "127.0.0.1:5432" }).serviceEnv.DATABASE_URL;
  const acme = creds("acme");
  const globex = creds("globex");
  const acmeToGlobex = acme.replace("/tenant_acme", "/tenant_globex"); // acme creds → globex DB

  // 공유 PG 에 두 테넌트 DB 가 생겼나.
  const dbs = nomad([
    "alloc",
    "exec",
    "-task",
    "assay-shared-postgres",
    allocId,
    "psql",
    "-U",
    "assay",
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
  console.log(`acme creds → tenant_globex : ${cross}   <-- 교차접속(거부돼야 함)`);

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
      ? "\n✅ Nomad pool 멀티테넌트: 공유 PG 1개 + 테넌트별 DB/role/creds — 테넌트 A creds 로 B DB 접속 거부, 자기 DB 만 허용. K8s↔Nomad pool 격리 패리티."
      : "\n⚠️ 일부 체크 실패",
  );
} finally {
  await rt.teardown(spec, zone("acme")).catch(() => {});
  await rt.teardown(spec, zone("globex")).catch(() => {});
  try {
    nomad(["job", "stop", "-purge", SHARED_STORE_JOB_ID]);
  } catch {}
  console.log("teardown: 토폴로지/공유스토어 잡 purge 요청됨");
}
process.exit(ok ? 0 : 1);
