// live: Nomad network isolation = Consul Connect intentions. Create tenant intentions on real Consul (same-tenant allow + * deny)
// and verify the authorization decision via Consul's **intention-check API** (/v1/connect/intentions/check) — this is the allow/deny
// decision the mesh (Envoy) will actually enforce. i.e. live-prove the "cross-tenant = DENIED, same-tenant = ALLOWED" decision even without Envoy.
//   (full data-plane enforce requires the service job to be Connect-enabled [envoy sidecar] — a documented follow-up.)
//
// Prereq: run Consul (Connect CA on). Usage: CONSUL_HTTP_ADDR=http://127.0.0.1:8500 node scripts/live/consul-intentions-nomad.mjs
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

// Consul's authorization decision (what the mesh will enforce): is source→destination allowed?
const check = async (source, destination) => {
  const r = await fetch(`${ADDR}/v1/connect/intentions/check?source=${source}&destination=${destination}`);
  return (await r.json()).Allowed;
};

console.log("Nomad network isolation (Consul Connect intentions) — verify the cross-tenant deny decision\n");
const tenants = ["acme", "globex"];
let ok = false;
try {
  // create both tenants' intentions + the shared-store intention on real Consul.
  for (const t of tenants)
    for (const intent of buildTenantIntentions(spec, zone(t))) await consul.applyIntention(intent);
  await consul.applyIntention(buildSharedStoreIntention("postgres"));

  const A = (svc) => meshServiceName("acme", svc);
  const G = (svc) => meshServiceName("globex", svc);
  // verify the decisions (= the allow/deny Envoy will enforce):
  const sameTenant = await check(A("browser-mcp"), A("agent-server")); // same tenant → allow
  const crossTenant = await check(A("agent-server"), G("agent-server")); // cross tenant → deny
  const tenantToStore = await check(A("agent-server"), "everdict-shared-postgres"); // tenant → shared store → allow
  const rogueToTenant = await check("rogue-svc", G("agent-server")); // non-mesh/non-tenant → deny

  console.log(`same-tenant  acme-mcp → acme-agent     : ${sameTenant ? "ALLOWED" : "DENIED"}`);
  console.log(`cross-tenant acme-agent → globex-agent : ${crossTenant ? "ALLOWED" : "DENIED"}   <-- should be denied`);
  console.log(`tenant→store acme-agent → shared-pg    : ${tenantToStore ? "ALLOWED" : "DENIED"}`);
  console.log(
    `rogue        rogue → globex-agent       : ${rogueToTenant ? "ALLOWED" : "DENIED"}   <-- should be denied`,
  );

  ok = sameTenant === true && crossTenant === false && tenantToStore === true && rogueToTenant === false;
  console.log(
    `\nchecks: same-allow=${sameTenant === true} cross-deny=${crossTenant === false} store-allow=${tenantToStore === true} rogue-deny=${rogueToTenant === false}`,
  );
  console.log(
    ok
      ? "\n✅ Consul Connect intentions: same-tenant allow + cross-tenant/non-mesh deny — verified via real Consul's authorization decision (the decision the mesh will enforce). K8s NetworkPolicy ↔ Nomad Consul-intentions network isolation parity (decision level)."
      : "\n⚠️ some checks failed",
  );
} finally {
  for (const t of tenants)
    for (const s of spec.services) await consul.deleteIntention(meshServiceName(t, s.name)).catch(() => {});
  await consul.deleteIntention("everdict-shared-postgres").catch(() => {});
  console.log("teardown: intention deletion requested");
}
process.exit(ok ? 0 : 1);
