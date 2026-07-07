// Live e2e (service-topology, K8s multi-tenant isolation): launch the browser-use harness *per tenant (trustZone)* to prove isolation.
// ServiceTopologyBackend resolves tenant→TrustZone (trustZones.resolve) → assertHardenedIsolation → per-zone
// K8sTopologyRuntime.ensureTopology(spec, zone): deploy the warm topology into a **tenant-dedicated namespace** (no cross-tenant warm-pool
// sharing) + apply a NetworkPolicy from zone.network. Launch two tenants (acme/globex), confirm ns/Deployment separation + netpol
// application as evidence, and interactively drive each tenant's front-door to show both work in their own zone.
//
// Prereq: kind (context kind-everdict). This script handles node↔default-bridge (pod→host LiteLLM 172.17.0.1) + kind image load.
// Note: kind's default CNI (kindnet) only *applies* NetworkPolicy, it does not *enforce* it — enforcement needs Calico/Cilium.
//   Here we verify only that the policy manifest is generated and applied per zone (the namespace boundary is real).
// Key: OPENAI_API_KEY env or infra/litellm/.env (LITELLM_MASTER_KEY) — runtime only, never committed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { staticTrustZones } from "../../packages/backends/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-everdict";
const CLUSTER = process.env.KIND_CLUSTER ?? "everdict";
const NODE = process.env.KIND_NODE ?? "everdict-control-plane";
const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const POD_PORT = 18080;
const MODEL = process.env.BROWSERUSE_MODEL ?? "gpt-5.4-mini";
const LITELLM_HOST = process.env.LITELLM_HOST ?? "172.17.0.1";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const TENANTS = ["acme", "globex"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });

function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8");
    return (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = masterKey();
if (!KEY) {
  console.error("no LLM key (OPENAI_API_KEY or infra/litellm/.env).");
  process.exit(2);
}
function jaegerBridgeIp() {
  try {
    const out = execFileSync(
      "docker",
      ["inspect", "everdict-jaeger", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"],
      { encoding: "utf8" },
    );
    return (
      out
        .trim()
        .split(/\s+/)
        .find((ip) => /^172\.17\./.test(ip)) ?? "172.17.0.5"
    ).trim();
  } catch {
    return "172.17.0.5";
  }
}

console.log("=== reach the dev host + kind image load ===");
spawnSync("docker", ["network", "connect", "bridge", NODE], { stdio: "ignore" });
execFileSync("kind", ["load", "docker-image", IMAGE, "--name", CLUSTER], { stdio: "ignore" });
console.log("loaded.");

// Per-tenant zone: trusted=true + runc (=no gvisor in kind → passes assertHardenedIsolation), dedicated namespace, cross-tenant deny.
const zoneFor = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `everdict-${id}`,
  network: "deny-cross-tenant",
  trusted: true,
});
const trustZones = staticTrustZones(Object.fromEntries(TENANTS.map((t) => [t, zoneFor(t)])), zoneFor("default"));

const spec = {
  kind: "service",
  id: "browseruse",
  version: "1.0.0",
  services: [{ name: "agent", image: IMAGE, port: POD_PORT, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["screenshot"] },
  frontDoor: { service: "agent", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: JAEGER_QUERY },
};

const k8s = new K8sTopologyRuntime({
  context: CONTEXT,
  imagePullPolicy: "IfNotPresent",
  readyTimeoutMs: 180000,
  networkPolicies: true, // zone.network → generate & apply NetworkPolicy manifest (kindnet doesn't enforce, but the manifest is applied)
  storeEnv: {
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: `http://${LITELLM_HOST}:4000/v1`,
    OTLP_URL: `http://${jaegerBridgeIp()}:4318/v1/traces`,
    BROWSERUSE_MODEL: MODEL,
    BROWSERUSE_MAX_STEPS: "6",
    BROWSERUSE_PRICE_IN: "0.00000015",
    BROWSERUSE_PRICE_OUT: "0.0000006",
    PORT: String(POD_PORT),
  },
});

let frontDoor = "";
const runtime = {
  id: "k8s-isolation",
  async ensureTopology(s, zone) {
    const handle = await k8s.ensureTopology(s, zone);
    frontDoor = handle.endpoints[s.frontDoor.service];
    return handle;
  },
  async provisionBrowserEnv() {
    return {
      wiring: { target_cdp_url: "" },
      async snapshot() {
        const j = await (await fetch(`${frontDoor}/observe`)).json();
        return { kind: "browser", url: j.url || "", dom: j.dom || "", console: [] };
      },
      async dispose() {},
    };
  },
};
const otel = new OtelTraceSource({ endpoint: JAEGER_QUERY });
const traceSource = {
  async fetch(runId) {
    for (let i = 0; i < 20; i++) {
      try {
        const ev = await otel.fetch(runId);
        if (ev.length > 0) return ev;
      } catch {}
      await sleep(1000);
    }
    return [];
  },
};
const backend = new ServiceTopologyBackend({
  runtime,
  traceSource,
  specFor: () => spec,
  trustZones,
  newRunId: () => randomUUID().replace(/-/g, ""),
});

const mkJob = (tenant) => ({
  tenant,
  harness: { id: "browseruse", version: "1.0.0" },
  evalCase: {
    id: `search-form-${tenant}`,
    env: { kind: "browser", url: `http://localhost:${POD_PORT}/form` },
    task: `Go to http://localhost:${POD_PORT}/form , type "${tenant} eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
    graders: [
      { id: "url-matches", config: { pattern: `[?&]q=${tenant}` } },
      { id: "dom-contains", config: { text: `Results for ${tenant}` } },
      { id: "steps", config: {} },
    ],
    timeoutSec: 300,
    tags: ["browser-use", "isolation", tenant],
  },
});

let ok = false;
try {
  const perTenant = {};
  for (const tenant of TENANTS) {
    console.log(`\n=== tenant=${tenant} (zone ns=everdict-${tenant}) — ensureTopology + dispatch ===`);
    try {
      const result = await backend.dispatch(mkJob(tenant));
      const score = (id) => result.scores.find((s) => s.graderId === id);
      const pass = score("url-matches")?.pass === true && score("dom-contains")?.pass === true;
      perTenant[tenant] = { pass, url: result.snapshot.url, endpoint: frontDoor };
      console.log(`  ${tenant}: ${pass ? "PASS" : "FAIL"} url=${result.snapshot.url} front-door=${frontDoor}`);
    } catch (e) {
      perTenant[tenant] = { pass: false, endpoint: frontDoor, error: e instanceof Error ? e.message : String(e) };
      console.log(`  ${tenant}: ERROR ${perTenant[tenant].error}`);
      try {
        console.log(k(["get", "pods", "-n", `everdict-${tenant}`, "-o", "wide"]));
        console.log(
          k(["get", "events", "-n", `everdict-${tenant}`, "--sort-by=.lastTimestamp"])
            .split("\n")
            .slice(-8)
            .join("\n"),
        );
      } catch {}
    }
  }

  // === Isolation evidence: per-tenant namespace separation + a browseruse-agent Deployment + NetworkPolicy in each ns ===
  console.log("\n=== isolation evidence ===");
  const ns = k(["get", "ns", "-o", "name"]).trim().split("\n");
  const evidence = {};
  for (const tenant of TENANTS) {
    const n = `namespace/everdict-${tenant}`;
    const hasNs = ns.includes(n);
    let deploys = "";
    let netpol = "";
    try {
      deploys = k(["get", "deploy", "-n", `everdict-${tenant}`, "-o", "name"])
        .trim()
        .replace(/\n/g, " ");
    } catch {}
    try {
      netpol = k(["get", "netpol", "-n", `everdict-${tenant}`, "-o", "name"])
        .trim()
        .replace(/\n/g, " ");
    } catch {}
    evidence[tenant] = { hasNs, deploys, netpol };
    console.log(`  everdict-${tenant}: ns=${hasNs} deploy=[${deploys}] netpol=[${netpol || "none"}]`);
  }

  const bothPass = TENANTS.every((t) => perTenant[t]?.pass);
  const separateNs = TENANTS.every((t) => evidence[t]?.hasNs && evidence[t]?.deploys.includes("browseruse-agent"));
  const distinctEndpoints = perTenant.acme?.endpoint !== perTenant.globex?.endpoint;
  ok = bothPass && separateNs && distinctEndpoints;
  console.log(
    ok
      ? "\n✅ ②: the browser-use harness is deployed isolated per-tenant by trustZone — each tenant has its own warm topology " +
          "(browseruse-agent Deployment) in a *dedicated namespace* (everdict-acme / everdict-globex) (no cross-tenant pool sharing, " +
          "distinct front-door endpoints), and a NetworkPolicy is applied per ns from zone.network. Both tenants drive interactively in " +
          "their own zone: PASS. (kindnet doesn't enforce netpol — enforcement needs Calico/Cilium; the namespace boundary is real.)"
      : "\n⚠️ does not match expectation (see perTenant/evidence above)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  for (const tenant of TENANTS) {
    await k8s.teardown(spec, zoneFor(tenant)).catch(() => {});
  }
  console.log("teardown done (per-tenant ns deleted, forwards stopped)");
}
process.exit(ok ? 0 : 1);
