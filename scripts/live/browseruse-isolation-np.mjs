// Live e2e (service-topology, NetworkPolicy enforcement): launch two browser-use tenants on a *Calico cluster (kind-everdict-np)*
// to verify the deny-cross-tenant NetworkPolicy actually *blocks* cross-tenant traffic. Unlike browseruse-isolation-k8s.mjs (kindnet,
// no policy enforcement), here Calico enforces the policy → acme pod → globex's browseruse-agent service = BLOCKED,
// same ns = REACHABLE. (The enforcement network-isolation-k8s.mjs proved with an echo service, now via the browser-use front-door.)
//
// Prereq: kind-everdict-np (Calico CNI). This script handles kind image load + node↔default-bridge (pod→host LiteLLM).
// Key: OPENAI_API_KEY env or infra/litellm/.env (LITELLM_MASTER_KEY) — runtime only, never committed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { staticTrustZones } from "../../packages/backends/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-everdict-np";
const CLUSTER = process.env.KIND_CLUSTER ?? "everdict-np";
const NODE = process.env.KIND_NODE ?? "everdict-np-control-plane";
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

// Measure whether a curl pod inside the ns can reach the target service (REACHABLE/BLOCKED).
function probe(ns, url) {
  const pod = `probe-${Math.floor(Number(`0x${randomUUID().slice(0, 6)}`))}`;
  try {
    const out = execFileSync(
      "kubectl",
      [
        "--context",
        CONTEXT,
        "run",
        pod,
        "-n",
        ns,
        "--rm",
        "-i",
        "--restart=Never",
        "--image=curlimages/curl:latest",
        "--command",
        "--",
        "sh",
        "-c",
        `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 ${url} 2>/dev/null); [ "$code" = "200" ] && echo REACHABLE || echo BLOCKED`,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    return out.includes("REACHABLE") ? "REACHABLE" : "BLOCKED";
  } catch {
    return "BLOCKED";
  }
}

console.log("=== reach the dev host + kind image load (kind-everdict-np, Calico) ===");
spawnSync("docker", ["network", "connect", "bridge", NODE], { stdio: "ignore" });
execFileSync("kind", ["load", "docker-image", IMAGE, "--name", CLUSTER], { stdio: "ignore" });
console.log("loaded.");

const zoneFor = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `everdict-np-${id}`,
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
  networkPolicies: true,
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
  id: "k8s-np",
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
    ],
    timeoutSec: 300,
    tags: ["browser-use", "isolation-np", tenant],
  },
});

let ok = false;
try {
  // Deploy two tenants + drive each interactively in its own zone (both work).
  const drive = {};
  for (const tenant of TENANTS) {
    console.log(`\n=== tenant=${tenant} (ns=everdict-np-${tenant}) — deploy + drive ===`);
    try {
      const r = await backend.dispatch(mkJob(tenant));
      const score = (id) => r.scores.find((s) => s.graderId === id);
      drive[tenant] = score("url-matches")?.pass === true && score("dom-contains")?.pass === true;
      console.log(`  ${tenant}: drive ${drive[tenant] ? "PASS" : "FAIL"} url=${r.snapshot.url}`);
    } catch (e) {
      drive[tenant] = false;
      console.log(`  ${tenant}: ERROR ${e instanceof Error ? e.message : e}`);
    }
  }

  // === NetworkPolicy enforcement check (Calico): same-ns reachable vs cross-tenant blocked ===
  console.log("\n=== NetworkPolicy enforcement check (Calico) ===");
  const svc = (t) => `http://browseruse-agent.everdict-np-${t}:${POD_PORT}/health`;
  const sameNs = probe("everdict-np-acme", svc("acme")); // acme pod → acme service (same ns) → should be allowed
  const crossNs = probe("everdict-np-acme", svc("globex")); // acme pod → globex service (cross) → should be blocked
  console.log(`  acme→acme   (same-ns) : ${sameNs}   <-- should be allowed`);
  console.log(`  acme→globex (cross)   : ${crossNs}   <-- should be blocked`);

  const enforce = sameNs === "REACHABLE" && crossNs === "BLOCKED";
  ok = drive.acme && drive.globex && enforce;
  console.log(
    ok
      ? "\n✅ ②: two browser-use tenants deployed into dedicated namespaces on a Calico cluster (kind-everdict-np) (both drive in their own zone: PASS), " +
          "and the deny-cross-tenant NetworkPolicy is **actually enforced** — the same-ns pod reaches the browseruse-agent service (REACHABLE), " +
          "the cross-tenant pod is blocked (BLOCKED). Unlike kindnet (no enforcement), Calico enforces the policy so the tenant boundary is real at the network level."
      : `\n⚠️ does not match expectation (drive acme=${drive.acme} globex=${drive.globex}, same=${sameNs}, cross=${crossNs})`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  for (const tenant of TENANTS) {
    await k8s.teardown(spec, zoneFor(tenant)).catch(() => {});
  }
  console.log("teardown done (per-tenant ns deleted)");
}
process.exit(ok ? 0 : 1);
