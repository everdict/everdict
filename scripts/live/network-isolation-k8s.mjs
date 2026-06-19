// 라이브: NetworkPolicy enforce 검증(멀티테넌트 네트워크 격리). **정책-CNI(Calico) 클러스터**에서만 enforce 됨
// (kindnet 은 정책을 무시 — 그래서 이 증명은 전용 calico 클러스터 kind-assay-np 에서 돌린다).
//   Part A (deny-cross-tenant): 테넌트 acme 파드 → 테넌트 globex 서비스 = 차단(globex ingress=같은-ns만),
//                               같은 ns → 허용. cross-tenant pod-to-pod 도달 차단.
//   Part B (공유 스토어 ingress): assay-managed 네임스페이스(acme) → 공유 PG = 허용, 비-managed ns → 차단.
//
// 준비: calico kind 클러스터 'assay-np' + echo/busybox/postgres 이미지 로드(scripts 주석/세션 참고).
// 사용: PATH=$HOME/.local/bin:$PATH node scripts/live/network-isolation-k8s.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime } from "../../packages/topology/dist/index.js";

const CTX = process.env.KIND_CONTEXT ?? "kind-assay-np";
const kc = (args, input) =>
  execFileSync("kubectl", ["--context", CTX, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// busybox 일회용 파드로 대상 도달성 판정 → "REACHABLE"/"BLOCKED".
let n = 0;
const probe = (ns, shCmd) => {
  n += 1;
  try {
    const out = kc([
      "-n",
      ns,
      "run",
      `probe-${n}`,
      "--image=busybox:1.36",
      "--image-pull-policy=IfNotPresent",
      "--restart=Never",
      "--rm",
      "-i",
      "--command",
      "--",
      "sh",
      "-c",
      `${shCmd} && echo REACHABLE || echo BLOCKED`,
    ]);
    return /REACHABLE/.test(out) ? "REACHABLE" : "BLOCKED";
  } catch {
    return "BLOCKED"; // timeout/비정상 종료 = 차단으로 간주
  }
};

const echoSvc = (id, ns) => `http://${id}-agent-server.${ns}:8080`;
const specOf = (id, deps) => ({
  kind: "service",
  id,
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "mendhak/http-https-echo:latest", port: 8080, needs: [], perRun: [], replicas: 1 },
  ],
  dependencies: deps,
  frontDoor: { service: "agent-server", submit: "POST /" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
});
const zone = (id, network, storeIsolation) => ({
  id,
  isolationRuntime: "runc",
  namespace: `assay-np-${id}`,
  network,
  trusted: true,
  storeIsolation,
});

const rt = new K8sTopologyRuntime({
  context: CTX,
  imagePullPolicy: "IfNotPresent",
  poolNamespace: "assay-shared",
  readyTimeoutMs: 150_000,
});

let aPass = false;
let bPass = false;
try {
  // ---- Part A: cross-tenant pod 차단 (deny-cross-tenant, external store) ----
  console.log("Part A: deny-cross-tenant — 테넌트 간 pod 도달 차단 검증 …");
  const specA = specOf("np-a", []);
  await rt.ensureTopology(specA, zone("acme", "deny-cross-tenant", "external"));
  await rt.ensureTopology(specA, zone("globex", "deny-cross-tenant", "external"));
  const sameNs = probe("assay-np-globex", `wget -T 6 -qO- ${echoSvc("np-a", "assay-np-globex")} >/dev/null 2>&1`);
  const crossNs = probe("assay-np-acme", `wget -T 6 -qO- ${echoSvc("np-a", "assay-np-globex")} >/dev/null 2>&1`);
  console.log(`  globex→globex(same-ns) : ${sameNs}`);
  console.log(`  acme→globex(cross)     : ${crossNs}   <-- 차단돼야 함`);
  aPass = sameNs === "REACHABLE" && crossNs === "BLOCKED";

  // ---- Part B: 공유 스토어 ingress — managed ns 만 허용 ----
  console.log("\nPart B: 공유 스토어 ingress — assay-managed ns 만 도달 허용 …");
  const specB = specOf("np-b", [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }]);
  await rt.ensureTopology(specB, zone("acme", "deny-cross-tenant", "pool")); // 공유 PG + ingress 정책 + acme(managed)
  // 비-managed 네임스페이스(정책/라벨 없음) 생성.
  kc(["create", "ns", "np-rogue"]);
  const fromManaged = probe("assay-np-acme", "nc -z -w6 assay-shared-postgres.assay-shared 5432");
  const fromRogue = probe("np-rogue", "nc -z -w6 assay-shared-postgres.assay-shared 5432");
  console.log(`  acme(managed)→shared PG : ${fromManaged}`);
  console.log(`  rogue(non-managed)→PG  : ${fromRogue}   <-- 차단돼야 함`);
  bPass = fromManaged === "REACHABLE" && fromRogue === "BLOCKED";

  const ok = aPass && bPass;
  console.log(`\nchecks: A.same-ns=${aPass} B.managed-only=${bPass}`);
  console.log(
    ok
      ? "\n✅ NetworkPolicy enforce(Calico): cross-tenant pod 도달 차단 + 공유 스토어는 assay-managed ns 에서만 도달. 트러스트존 네트워크 격리 라이브 확인."
      : "\n⚠️ 일부 체크 실패",
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await rt.teardown(specOf("np-a", []), zone("acme", "deny-cross-tenant", "external")).catch(() => {});
  await rt.teardown(specOf("np-a", []), zone("globex", "deny-cross-tenant", "external")).catch(() => {});
  await rt.teardown(specOf("np-b", []), zone("acme", "deny-cross-tenant", "pool")).catch(() => {});
  for (const ns of ["np-rogue", "assay-shared"]) kc(["delete", "ns", ns, "--ignore-not-found", "--wait=false"]);
  console.log("teardown: ns 삭제 요청됨");
}
