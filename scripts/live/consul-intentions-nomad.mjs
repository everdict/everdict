// 라이브: Nomad 네트워크 격리 = Consul Connect intentions. 실 Consul 에 테넌트 intention(같은 테넌트 allow + * deny)을
// 생성하고, Consul 의 **intention-check API**(/v1/connect/intentions/check)로 권한 결정을 검증한다 — 이게 메시(Envoy)가
// 실제로 enforce 할 allow/deny 결정이다. 즉 Envoy 없이도 "교차 테넌트 = DENIED, 같은 테넌트 = ALLOWED" 결정을 라이브 증명.
//   (full 데이터플레인 enforce 엔 서비스 잡이 Connect-enabled[envoy sidecar]여야 함 — 문서화된 follow-up.)
//
// 준비: Consul(Connect CA on) 실행. 사용: CONSUL_HTTP_ADDR=http://127.0.0.1:8500 node scripts/live/consul-intentions-nomad.mjs
import process from "node:process";
import {
  buildSharedStoreIntention,
  buildTenantIntentions,
  consulHttp,
  meshServiceName,
} from "../../packages/topology/dist/index.js";

const ADDR = (process.env.CONSUL_HTTP_ADDR ?? "http://127.0.0.1:8500").replace(/\/$/, "");
const consul = consulHttp(ADDR);

const spec = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "a:1", port: 8080, needs: [], perRun: [], replicas: 1 },
    { name: "browser-mcp", image: "b:1", port: 9000, needs: [], perRun: [], replicas: 1 },
  ],
  dependencies: [{ store: "postgres", role: "checkpoints", isolateBy: "thread_id" }],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};
const zone = (id) => ({
  id,
  isolationRuntime: "runc",
  network: "deny-cross-tenant",
  trusted: true,
  storeIsolation: "pool",
});

// Consul 의 권한 결정(메시가 enforce 할 것): source→destination 이 허용되나?
const check = async (source, destination) => {
  const r = await fetch(`${ADDR}/v1/connect/intentions/check?source=${source}&destination=${destination}`);
  return (await r.json()).Allowed;
};

console.log("Nomad 네트워크 격리(Consul Connect intentions) — 교차테넌트 거부 결정 검증\n");
const tenants = ["acme", "globex"];
let ok = false;
try {
  // 두 테넌트 intention + 공유 스토어 intention 을 실 Consul 에 생성.
  for (const t of tenants)
    for (const intent of buildTenantIntentions(spec, zone(t))) await consul.applyIntention(intent);
  await consul.applyIntention(buildSharedStoreIntention("postgres"));

  const A = (svc) => meshServiceName("acme", svc);
  const G = (svc) => meshServiceName("globex", svc);
  // 결정 검증(=Envoy 가 enforce 할 allow/deny):
  const sameTenant = await check(A("browser-mcp"), A("agent-server")); // 같은 테넌트 → 허용
  const crossTenant = await check(A("agent-server"), G("agent-server")); // 교차 테넌트 → 거부
  const tenantToStore = await check(A("agent-server"), "everdict-shared-postgres"); // 테넌트→공유스토어 → 허용
  const rogueToTenant = await check("rogue-svc", G("agent-server")); // 비메시/비테넌트 → 거부

  console.log(`same-tenant  acme-mcp → acme-agent     : ${sameTenant ? "ALLOWED" : "DENIED"}`);
  console.log(`cross-tenant acme-agent → globex-agent : ${crossTenant ? "ALLOWED" : "DENIED"}   <-- 거부돼야 함`);
  console.log(`tenant→store acme-agent → shared-pg    : ${tenantToStore ? "ALLOWED" : "DENIED"}`);
  console.log(`rogue        rogue → globex-agent       : ${rogueToTenant ? "ALLOWED" : "DENIED"}   <-- 거부돼야 함`);

  ok = sameTenant === true && crossTenant === false && tenantToStore === true && rogueToTenant === false;
  console.log(
    `\nchecks: same-allow=${sameTenant === true} cross-deny=${crossTenant === false} store-allow=${tenantToStore === true} rogue-deny=${rogueToTenant === false}`,
  );
  console.log(
    ok
      ? "\n✅ Consul Connect intentions: 같은 테넌트 allow + 교차 테넌트/비메시 deny — 실 Consul 의 권한 결정으로 검증(메시가 enforce 할 결정). K8s NetworkPolicy↔Nomad Consul-intentions 네트워크 격리 패리티(결정 레벨)."
      : "\n⚠️ 일부 체크 실패",
  );
} finally {
  for (const t of tenants)
    for (const s of spec.services) await consul.deleteIntention(meshServiceName(t, s.name)).catch(() => {});
  await consul.deleteIntention("everdict-shared-postgres").catch(() => {});
  console.log("teardown: intentions 삭제 요청됨");
}
process.exit(ok ? 0 : 1);
