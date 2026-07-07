// live: minio (object store) pool multi-tenant isolation. K8sTopologyRuntime mints per-tenant dedicated
// access key + bucket + bucket-scoped policy on a single shared minio via mc (mc is bundled in the server image → exec). Core proof (same as PG pool):
// tenant A's access key accessing tenant B's bucket → AccessDenied, its own bucket → OK.
//
// Prereq: kind 'everdict' + load the quay.io/minio/minio node image + mendhak/http-https-echo.
// Usage: PATH=$HOME/.local/bin:$PATH node scripts/live/minio-pool-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime, planTenantStores } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-everdict";
const POOL_NS = "everdict-shared";
const kc = (args, input) =>
  execFileSync("kubectl", ["--context", CTX, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

const spec = {
  kind: "service",
  id: "minio-demo",
  version: "1.0.0",
  // a port-less service → skip ensureTopology's front-door endpoint discovery (port-forward). Verifies only minio store isolation.
  services: [{ name: "agent-server", image: "mendhak/http-https-echo:latest", needs: [], perRun: [], replicas: 1 }],
  dependencies: [{ store: "minio", role: "snapshots", isolateBy: "object-prefix" }],
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `everdict-minio-${id}`,
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
  kc([
    "-n",
    POOL_NS,
    "get",
    "pod",
    "-l",
    "app=everdict-shared-minio",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ]).trim();
// inside the shared minio, set an alias with a given access key, then ls the bucket → OK / DENIED.
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

console.log(
  "minio pool multi-tenant isolation — shared minio + per-tenant access key/bucket, verify cross-bucket access is denied\n",
);
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
    "mc alias set l http://localhost:9000 everdict everdictsecret >/dev/null 2>&1; mc ls l",
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

  // the same scoped creds the runtime injects into the service (same plan).
  const creds = (id) => {
    const e = planTenantStores(spec, zone(id), { poolNamespace: POOL_NS }).serviceEnv;
    return { key: e.AWS_ACCESS_KEY_ID, secret: e.AWS_SECRET_ACCESS_KEY, bucket: e.S3_BUCKET };
  };
  const a = creds("acme");
  const g = creds("globex");

  const ownAcme = tryAccess(a.key, a.secret, a.bucket);
  const ownGlobex = tryAccess(g.key, g.secret, g.bucket);
  const cross = tryAccess(a.key, a.secret, g.bucket); // acme key → globex bucket
  console.log(`\nacme key → tenant-acme    : ${ownAcme}`);
  console.log(`globex key → tenant-globex : ${ownGlobex}`);
  console.log(`acme key → tenant-globex  : ${cross}   <-- cross access (should be denied)`);

  ok = ownAcme === "OK" && ownGlobex === "OK" && cross === "DENIED";
  console.log(
    `\nchecks: own-acme=${ownAcme === "OK"} own-globex=${ownGlobex === "OK"} cross-denied=${cross === "DENIED"}`,
  );
  console.log(
    ok
      ? "\n✅ minio pool: shared object store + per-tenant access key/bucket/policy — tenant A's key is denied access to B's bucket, allowed only on its own bucket. Third store type (snapshots) isolation complete."
      : "\n⚠️ some checks failed",
  );
} finally {
  await rt.teardown(spec, zone("acme")).catch(() => {});
  await rt.teardown(spec, zone("globex")).catch(() => {});
  kc(["delete", "ns", POOL_NS, "--ignore-not-found", "--wait=false"]);
  console.log("teardown: ns deletion requested");
}
process.exit(ok ? 0 : 1);
