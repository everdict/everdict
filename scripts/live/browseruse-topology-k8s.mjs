// Live e2e (service-topology final rung, K8s): **deploy *real browser-use* to kind via K8sTopologyRuntime** and
// drive it with ServiceTopologyBackend. Same interactive+trace path as browseruse-topology-drive.mjs (local docker),
// but this time via *real orchestrator deploy*: K8sTopologyRuntime.ensureTopology applies the browser-use front-door as
// a Deployment+Service → waits for rollout → discovers it via port-forward. Inside the front-door pod, real LLM (host LiteLLM)
// + real chromium drive the form multi-step, and the run's real tokens/actions are emitted to Jaeger (bridge) over OTLP →
// the backend pulls them via OtelTraceSource to score.
//
// Prereqs (dev kind host-reachability recipe, same as aider-k8s):
//   - Connect the kind node to the default docker bridge → pods reach host LiteLLM(172.17.0.1:4000) (this script does it idempotently).
//   - Jaeger(everdict-jaeger) is a default-bridge container → pods emit OTLP to that bridge IP:4318, host pulls at :16686.
//   - Load the image into kind: this script runs `kind load docker-image everdict-browseruse:demo --name everdict`.
// Key: OPENAI_API_KEY env or infra/litellm/.env(LITELLM_MASTER_KEY) — runtime only, never committed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-everdict";
const CLUSTER = process.env.KIND_CLUSTER ?? "everdict";
const NODE = process.env.KIND_NODE ?? "everdict-control-plane";
const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const POD_PORT = 18080; // front-door container-internal port (pod localhost). chromium reaches the form on this port from the same pod.
const MODEL = process.env.BROWSERUSE_MODEL ?? "gpt-5.4-mini";
const MAX_STEPS = process.env.BROWSERUSE_MAX_STEPS ?? "6";
const LITELLM_HOST = process.env.LITELLM_HOST ?? "172.17.0.1"; // default bridge gateway = host
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686"; // pull from host (127.0.0.1 published)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  console.error("No LLM key (OPENAI_API_KEY or infra/litellm/.env).");
  process.exit(2);
}

// Jaeger's default-bridge IP (where pods emit OTLP). Looked up dynamically from the everdict-jaeger container.
function jaegerBridgeIp() {
  if (process.env.JAEGER_IP) return process.env.JAEGER_IP;
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
        .find((ip) => /^172\.17\./.test(ip)) ??
      out.trim().split(/\s+/)[0] ??
      ""
    ).trim();
  } catch {
    return "";
  }
}
const JAEGER_IP = jaegerBridgeIp();
const OTLP_URL = JAEGER_IP ? `http://${JAEGER_IP}:4318/v1/traces` : "http://172.17.0.5:4318/v1/traces";

console.log("=== dev host-reachability setup (node↔default bridge) + kind image load ===");
spawnSync("docker", ["network", "connect", "bridge", NODE], { stdio: "ignore" }); // idempotent (harmless if already connected)
console.log(`LiteLLM=http://${LITELLM_HOST}:4000/v1 | OTLP=${OTLP_URL}`);
console.log(`kind load ${IMAGE} → cluster ${CLUSTER} (may take a few minutes) …`);
execFileSync("kind", ["load", "docker-image", IMAGE, "--name", CLUSTER], { stdio: "ignore" });
console.log("loaded.");

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
  storeEnv: {
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: `http://${LITELLM_HOST}:4000/v1`,
    OTLP_URL,
    BROWSERUSE_MODEL: MODEL,
    BROWSERUSE_MAX_STEPS: MAX_STEPS,
    PORT: String(POD_PORT),
  },
});

let frontDoor = ""; // port-forward endpoint (host) discovered by ensureTopology. Used by provisionBrowserEnv's /observe.
let ok = false;
try {
  console.log(`\n=== K8sTopologyRuntime.ensureTopology — deploy browser-use front-door to kind(${CONTEXT}) ===`);
  // Adapter runtime: deploy/discover via the real K8sTopologyRuntime, per-case observation via front-door /observe (browser-use spins up
  // its own browser, so we use front-door observation instead of a separate chromedp pod — same as the local docker path).
  const runtime = {
    id: "k8s-browseruse",
    async ensureTopology(s, zone) {
      const handle = await k8s.ensureTopology(s, zone);
      frontDoor = handle.endpoints[s.frontDoor.service];
      console.log("discovered front-door endpoint:", frontDoor);
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
      for (let i = 0; i < 25; i++) {
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
    newRunId: () => randomUUID().replace(/-/g, ""),
  });

  const job = {
    tenant: "default",
    harness: { id: "browseruse", version: "1.0.0" },
    evalCase: {
      id: "search-form-k8s",
      env: { kind: "browser", url: `http://localhost:${POD_PORT}/form` },
      task: `Go to http://localhost:${POD_PORT}/form , type "everdict eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
      graders: [
        { id: "url-matches", config: { pattern: "[?&]q=everdict" } },
        { id: "dom-contains", config: { text: "Results for everdict" } },
        { id: "steps", config: {} },
        { id: "cost", config: {} },
      ],
      timeoutSec: 300,
      tags: ["browser-use", "service-topology", "k8s", "interactive", "trace"],
    },
  };

  console.log(
    "\n=== ServiceTopologyBackend.dispatch — drive real browser-use in the kind pod interactively + score from real trace ===",
  );
  console.log("model:", MODEL, "| task:", job.evalCase.task);
  const result = await backend.dispatch(job); // ← ensureTopology creates the ns+Deployment and drives it

  // Evidence of the real cluster deploy (queried after dispatch created it, before teardown).
  const k = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });
  let ready = "";
  try {
    ready = k([
      "get",
      "deploy",
      "browseruse-agent",
      "-n",
      "everdict-default",
      "-o",
      "jsonpath={.status.readyReplicas}/{.status.replicas}",
    ]);
  } catch {}
  console.log("k8s deploy browseruse-agent ready:", ready);

  let observed = {};
  try {
    observed = await (await fetch(`${frontDoor}/observe`)).json();
  } catch {}
  const llmCalls = result.trace.filter((e) => e.kind === "llm_call");
  const toolCalls = result.trace.filter((e) => e.kind === "tool_call");
  console.log("\n--- CaseResult ---");
  console.log("snapshot.kind =", result.snapshot.kind, "| url =", result.snapshot.url);
  console.log("snapshot.dom(first 100):", String(result.snapshot.dom).slice(0, 100).replace(/\s+/g, " "));
  console.log("browser-use actions:", JSON.stringify(observed.actions), "| tokens:", JSON.stringify(observed.tokens));
  console.log(
    "trace(pulled from Jaeger):",
    `llm_call=${llmCalls.length}`,
    `tool_call=${toolCalls.length}`,
    llmCalls[0]
      ? `model=${llmCalls[0].model} in=${llmCalls[0].cost?.inputTokens} out=${llmCalls[0].cost?.outputTokens}`
      : "",
  );
  console.log("scores =", JSON.stringify(result.scores.map((s) => ({ id: s.graderId, pass: s.pass, value: s.value }))));
  if (observed.error) console.log("front-door note:", String(observed.error).slice(0, 300));

  const score = (id) => result.scores.find((s) => s.graderId === id);
  const urlOk = score("url-matches")?.pass === true;
  const domOk = score("dom-contains")?.pass === true;
  const stepsOk = (score("steps")?.value ?? 0) > 0;
  const tracePulled = llmCalls.length > 0 && toolCalls.length > 0;
  ok = ready.startsWith("1") && result.snapshot.kind === "browser" && urlOk && domOk && stepsOk && tracePulled;
  console.log(
    ok
      ? "\n✅ ①: **deployed the real browser-use image to kind via K8sTopologyRuntime** (Deployment+Service apply→rollout→port-forward) " +
          "and drove it with ServiceTopologyBackend — inside the pod, real LLM (host LiteLLM) + real chromium drove the interactive form " +
          "multi-step to reach the result (url/dom PASS), and the run's real tokens/actions were emitted to Jaeger (bridge) over OTLP → " +
          "pulled via OtelTraceSource to score steps/cost. Closes the orchestrator deploy over the real K8s path too."
      : "\n⚠️ mismatch vs expected (see ready/actions/trace/scores above)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  await k8s.teardown(spec).catch(() => {});
  console.log("teardown done (forwards stopped, ns deleted)");
}
process.exit(ok ? 0 : 1);
