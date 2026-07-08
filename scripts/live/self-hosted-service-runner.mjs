// Live e2e: a SERVICE (topology) harness on a self-hosted runner's local Docker.
// The full user path — no hand-driven backend: pair a runner → `everdict runner` (auto-advertises docker) →
// register a service harness → submit a run pinned to self:<runnerId> → the runner's lease loop branches
// kind=service → DockerTopologyRuntime stands the front-door up in local Docker → front-door drive → result
// (trace degraded: the traceSource endpoint is intentionally dead). Design: docs/architecture/self-hosted-service-runner.md.
//
// Prereqs: pnpm build · a running control plane · a local Docker daemon.
// Usage:   EVERDICT_API_KEY=ak_… [EVERDICT_API_URL=http://127.0.0.1:8787] node scripts/live/self-hosted-service-runner.mjs
import { execFileSync, spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const KEY = process.env.EVERDICT_API_KEY;
if (!KEY) throw new Error("EVERDICT_API_KEY is required (ak_…)");
const H = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

const STUB_IMAGE = "everdict-frontdoor-stub:e2e";
const SUFFIX = Math.random().toString(36).slice(2, 7);
const HARNESS_ID = `stub-svc-${SUFFIX}`;

// 0) the stub front-door image (200 JSON on every request) — built from the repo's topology stub.
console.log("▶ building stub front-door image");
execFileSync("docker", ["build", "-q", "-t", STUB_IMAGE, "scripts/live/topology-stub"], { stdio: "inherit" });

// 1) device pairing → rnr_ token (shown once).
const { runner, token } = await api("/runners", {
  method: "POST",
  body: JSON.stringify({ label: "svc-e2e", capabilities: ["git"] }),
});
console.log(`▶ paired runner ${runner.id}`);

// 2) service harness — one front-door service, no stores, dead traceSource (degraded-trace path by design).
await api("/harness-templates", {
  method: "POST",
  body: JSON.stringify({
    kind: "service",
    category: "topology",
    id: HARNESS_ID,
    version: "1",
    services: [{ name: "frontdoor", image: STUB_IMAGE, port: 8080, needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies: [],
    frontDoor: { service: "frontdoor", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://127.0.0.1:59997" },
  }),
});
await api("/harnesses", {
  method: "POST",
  body: JSON.stringify({
    template: { id: HARNESS_ID, version: "1" },
    id: HARNESS_ID,
    version: "1.0.0",
    pins: { frontdoor: STUB_IMAGE }, // a service template's services are image slots — pin each at instance time
  }),
});
console.log(`▶ registered service harness ${HARNESS_ID}@1.0.0`);

// 3) this machine as a runner — probes docker on start and advertises the docker capability on lease.
const runnerProc = spawn(
  process.execPath,
  ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", B, "--poll-interval-ms", "1000"],
  { stdio: "inherit" },
);
const cleanup = () => {
  if (!runnerProc.killed) runnerProc.kill("SIGINT");
};
process.on("exit", cleanup);

try {
  await sleep(2500);

  // 4) submit a run pinned to self:<runnerId> — the dispatcher's capability gate must let it through (docker present).
  const submitted = await api("/runs", {
    method: "POST",
    body: JSON.stringify({
      harness: { id: HARNESS_ID, version: "1.0.0" },
      case: {
        id: `svc-e2e-${SUFFIX}`,
        env: { kind: "prompt" },
        task: "ping the stub front door",
        graders: [{ id: "steps" }],
        timeoutSec: 180,
        tags: ["live", "service", "self-hosted"],
        placement: { target: `self:${runner.id}` },
      },
    }),
  });
  console.log(`▶ submitted run ${submitted.id} → self:${runner.id}`);

  let rec;
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    rec = await api(`/runs/${submitted.id}`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  if (rec.status !== "succeeded")
    throw new Error(`run ${rec.status}: ${JSON.stringify(rec.error ?? rec.result?.failure)}`);

  const prov = rec.result?.provenance;
  if (prov?.ranOn !== "self-hosted" || prov.runner !== runner.id)
    throw new Error(`✗ provenance mismatch: ${JSON.stringify(prov)}`);
  // Degraded-trace path by design: the dead traceSource leaves an error event, scoring still lands (steps).
  const trace = rec.result?.trace ?? [];
  if (!trace.some((e) => e.kind === "error" && String(e.message).includes("trace fetch failed")))
    throw new Error(`✗ expected the degraded-trace marker: ${JSON.stringify(trace).slice(0, 200)}`);
  if (!(rec.result?.scores ?? []).some((sc) => sc.graderId === "steps")) throw new Error("✗ steps score missing");
  // The drive itself is visible in the topology container: readiness GET + POST /runs with per-run wiring.
  const container = `everdict-${HARNESS_ID}-1.0.0-frontdoor`;
  const logs = execFileSync("docker", ["logs", container], { encoding: "utf8" });
  if (!logs.includes("POST /runs") || !logs.includes("thread_id"))
    throw new Error(`✗ front-door drive not visible in ${container} logs`);
  console.log("✓ topology stood up in local Docker and the front door was driven with per-run wiring");
  console.log(`✓ provenance: ranOn=${prov.ranOn} runner=${prov.runner} · trace degraded as designed`);
  console.log("PASS self-hosted-service-runner");
} finally {
  cleanup();
  // Tear the warm topology down so repeated e2e runs start clean.
  try {
    execFileSync("docker", ["rm", "-f", `everdict-${HARNESS_ID}-1.0.0-frontdoor`], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}
