// Live e2e: the CONNECTION PROBE (register-time validation + scope discovery) against real MLflow 3.14.
//   probeTraceConnection({kind:"mlflow", endpoint}) → validates the connection AND lists the platform's real
//   experiments as selectable scopes (what the web form's "Test connection" does before enabling Save).
//   Also drives it through TraceSourceService.probe (the actual API/MCP path) to prove the injected wiring.
//
//   A) reachable + discovery: a real MLflow → reachable=true, scopeKind="experiment", the created experiment is in scopes.
//   B) unreachable: a dead endpoint → reachable=false, reason="unreachable" (no throw — a classified result).
//   C) service path: TraceSourceService.probe(ws,{kind,endpoint}) returns the same discovery (injected probeConnection).
//
// Prereq: docker (boots ghcr.io/mlflow/mlflow:v3.14.0, no auth, sqlite). Set MLFLOW_ENDPOINT to reuse a server.
// Usage: node scripts/live/trace-connection-probe-mlflow.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { TraceSourceService } from "../../packages/application-control/dist/index.js";
import { InMemoryWorkspaceSettingsStore } from "../../packages/db/dist/index.js";
import { probeTraceConnection } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-trace-probe-e2e";
let bootedDocker = false;
let ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "";

const up = async (url) => {
  try {
    return (await fetch(`${url}/version`)).ok;
  } catch {
    return false;
  }
};
const assert = (cond, label) => {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:5509";
  console.log(`MLflow boot (docker, v3.14.0, no auth) → ${ENDPOINT}`);
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "5509:5000",
    "ghcr.io/mlflow/mlflow:v3.14.0",
    "mlflow",
    "server",
    "--host",
    "0.0.0.0",
    "--port",
    "5000",
    "--backend-store-uri",
    "sqlite:////tmp/mlflow-probe.db",
  ]);
  bootedDocker = true;
}
for (let i = 0; i < 60 && !(await up(ENDPOINT)); i++) await sleep(1000);
if (!(await up(ENDPOINT))) throw new Error(`MLflow did not come up: ${ENDPOINT}`);
console.log(`MLflow up: ${ENDPOINT} (version=${await (await fetch(`${ENDPOINT}/version`)).text()})`);

const api = async (path, init = {}) => {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

try {
  const expName = `everdict-probe-e2e-${Date.now()}`;
  const { experiment_id: experimentId } = await api("/api/2.0/mlflow/experiments/create", {
    method: "POST",
    body: JSON.stringify({ name: expName }),
  });
  console.log(`created experiment ${expName} (id=${experimentId})`);

  // A) engine: reachable + scope discovery.
  const okRes = await probeTraceConnection({ kind: "mlflow", endpoint: ENDPOINT });
  assert(okRes.reachable === true, "A1 reachable=true against real MLflow");
  assert(okRes.scopeKind === "experiment", "A2 scopeKind=experiment");
  assert(Array.isArray(okRes.scopes) && okRes.scopes.length > 0, "A3 scopes discovered");
  const found = okRes.scopes.find((s) => s.id === experimentId);
  assert(found !== undefined, "A4 the created experiment is in the discovered scopes");
  assert(found.name === expName, "A5 scope carries the experiment name (label)");

  // B) unreachable: a dead endpoint classifies, never throws.
  const dead = await probeTraceConnection({ kind: "mlflow", endpoint: "http://127.0.0.1:59997", timeoutMs: 3000 });
  assert(
    dead.reachable === false && dead.reason === "unreachable",
    "B1 dead endpoint → reachable=false, reason=unreachable",
  );

  // C) service path (the real API/MCP wiring): TraceSourceService.probe with the injected engine.
  const svc = new TraceSourceService(new InMemoryWorkspaceSettingsStore(), { probeConnection: probeTraceConnection });
  const viaService = await svc.probe("acme", { kind: "mlflow", endpoint: ENDPOINT });
  assert(viaService.reachable === true, "C1 TraceSourceService.probe reachable=true");
  assert(
    viaService.scopes.some((s) => s.id === experimentId),
    "C2 service probe surfaces the same experiment",
  );

  console.log("\n✅ trace connection probe e2e PASS");
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["rm", "-f", CONTAINER]);
      console.log(`removed ${CONTAINER}`);
    } catch {
      /* best effort */
    }
  }
}
