// 라이브: minio(오브젝트 스토어) pool 멀티테넌트 격리. K8sTopologyRuntime 이 공유 minio 1대에 테넌트별 전용
// access key + 버킷 + 버킷-한정 정책을 mc 로 mint(서버 이미지에 mc 내장 → exec). 핵심 증명(PG pool 과 동일):
// 테넌트 A access key 로 테넌트 B 버킷 접근 → AccessDenied, 자기 버킷 → OK.
//
// 준비: kind 'assay' + quay.io/minio/minio 노드 로드 + mendhak/http-https-echo.
// 사용: PATH=$HOME/.local/bin:$PATH node scripts/live/minio-pool-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime, planTenantStores } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-assay";
const POOL_NS = "assay-shared";
const kc = (args, input) =>
  execFileSync("kubectl", ["--context", CTX, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

const spec = {
  kind: "service",
  id: "minio-demo",
  version: "1.0.0",
  // 포트 없는 서비스 → ensureTopology 의 front-door 엔드포인트 발견(port-forward) skip. minio 스토어 격리만 검증.
  services: [{ name: "agent-server", image: "mendhak/http-https-echo:latest", needs: [], perRun: [], replicas: 1 }],
  dependencies: [{ store: "minio", role: "snapshots", isolateBy: "object-prefix" }],
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `assay-minio-${id}`,
  network: "deny-cross-tenant",
  trusted: true,
  storeIsolation: "pool",
});

const rt = new K8sTopologyRuntime({
  context: CTX,
  imagePullPolicy: "IfNotPresent",
  poolNamespace: POOL_NS,
  readyTimeoutMs: 150_000,
});

const minioPod = () =>
  kc(["-n", POOL_NS, "get", "pod", "-l", "app=assay-shared-minio", "-o", "jsonpath={.items[0].metadata.name}"]).trim();
// 공유 minio 안에서 임의 access key 로 alias 설정 후 버킷 ls → OK / DENIED.
const tryAccess = (accessKey, secret, bucket) => {
  try {
    const out = kc([
      "-n",
      POOL_NS,
      "exec",
      minioPod(),
      "--",
      "sh",
      "-c",
      `mc alias set t http://localhost:9000 ${accessKey} '${secret}' >/dev/null 2>&1 && mc ls t/${bucket} 2>&1`,
    ]);
    return /denied|Access Denied|permission/i.test(out) ? "DENIED" : "OK";
  } catch (e) {
    const msg = (e.stdout ?? e.stderr ?? "").toString();
    return /denied|Access Denied|permission/i.test(msg) ? "DENIED" : `ERR(${msg.split("\n").pop()?.slice(0, 70)})`;
  }
};

console.log("minio pool 멀티테넌트 격리 — 공유 minio + 테넌트별 access key/버킷, 교차 버킷 접근 거부 검증\n");
let ok = false;
try {
  await rt.ensureTopology(spec, zone("acme"));
  await rt.ensureTopology(spec, zone("globex"));

  const buckets = kc([
    "-n",
    POOL_NS,
    "exec",
    minioPod(),
    "--",
    "sh",
    "-c",
    "mc alias set l http://localhost:9000 assay assaysecret >/dev/null 2>&1; mc ls l",
  ]);
  console.log(
    "shared minio buckets:",
    buckets
      .trim()
      .split("\n")
      .map((b) => b.split("/").pop())
      .filter(Boolean)
      .join(", "),
  );

  // 런타임이 서비스에 주입하는 것과 동일한 scoped creds(같은 plan).
  const creds = (id) => {
    const e = planTenantStores(spec, zone(id), { poolNamespace: POOL_NS }).serviceEnv;
    return { key: e.AWS_ACCESS_KEY_ID, secret: e.AWS_SECRET_ACCESS_KEY, bucket: e.S3_BUCKET };
  };
  const a = creds("acme");
  const g = creds("globex");

  const ownAcme = tryAccess(a.key, a.secret, a.bucket);
  const ownGlobex = tryAccess(g.key, g.secret, g.bucket);
  const cross = tryAccess(a.key, a.secret, g.bucket); // acme key → globex 버킷
  console.log(`\nacme key → tenant-acme    : ${ownAcme}`);
  console.log(`globex key → tenant-globex : ${ownGlobex}`);
  console.log(`acme key → tenant-globex  : ${cross}   <-- 교차 접근(거부돼야 함)`);

  ok = ownAcme === "OK" && ownGlobex === "OK" && cross === "DENIED";
  console.log(
    `\nchecks: own-acme=${ownAcme === "OK"} own-globex=${ownGlobex === "OK"} cross-denied=${cross === "DENIED"}`,
  );
  console.log(
    ok
      ? "\n✅ minio pool: 공유 오브젝트 스토어 + 테넌트별 access key/버킷/정책 — 테넌트 A 키로 B 버킷 접근 거부, 자기 버킷만 허용. 3번째 스토어 타입(스냅샷) 격리 완성."
      : "\n⚠️ 일부 체크 실패",
  );
} finally {
  await rt.teardown(spec, zone("acme")).catch(() => {});
  await rt.teardown(spec, zone("globex")).catch(() => {});
  kc(["delete", "ns", POOL_NS, "--ignore-not-found", "--wait=false"]);
  console.log("teardown: ns 삭제 요청됨");
}
process.exit(ok ? 0 : 1);
