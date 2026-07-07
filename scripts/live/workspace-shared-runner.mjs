// live e2e: workspace-shared self-hosted runner (self:ws:<id>). Once an admin registers a team-resource runner,
// any member of that workspace runs jobs on the team runner by "just swapping the runtime" (self:ws:<runnerId>) (team build server/CI).
// Unlike a personal runner (self:<id>, own-pays), the cost is billed to the workspace (provenance.by="ws:<workspace>").
// Verify:
//   1) pair a team runner via POST /workspace/runners (owner=ws:<workspace>)
//   2) start the everdict runner (its rnr_ token → principal.subject="ws:<workspace>")
//   3) submit a run with runtime=self:ws:<id> → succeeded + provenance.ranOn=self-hosted + by="ws:<workspace>" (= workspace-billed)
//   4) cross-workspace isolation: if another workspace targets self:ws:<id>, NOT_FOUND (dispatch derives owner from the job tenant)
// Design: docs/architecture/self-hosted-runtime-and-runners.md (slice 3).
//
// Prereq:
//   pnpm build
//   node apps/api/dist/main.js            # control-plane API (:8787, in-memory, dev fallback auth)
// Usage:
//   node scripts/live/workspace-shared-runner.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const WS = "default"; // dev fallback → subject=dev, workspace=default, roles=[admin]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-everdict-tenant": WS, ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// 1) pair a workspace-shared runner (admin) → owner=ws:default, rnr_ token (shown once).
const { runner, token } = await api("/workspace/runners", {
  method: "POST",
  body: JSON.stringify({ label: "team-ci", capabilities: ["git"] }),
});
console.log(`▶ paired WORKSPACE runner ${runner.id} (${runner.label}) — owner=ws:${WS}`);

// 2) start this machine as the team runner. The token's subject=ws:<workspace>, so it leases the self:ws queue (no change to the runner core).
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
  await sleep(2500); // wait for the runner MCP connection

  // 3) a member submits a run with runtime=self:ws:<id> → runs on the team runner, cost billed to the workspace.
  const submitted = await api("/runs", {
    method: "POST",
    body: JSON.stringify({
      harness: { id: "scripted", version: "0" },
      case: {
        id: "e2e-ws-shared",
        env: { kind: "repo", source: { files: {} } },
        task: "say hi",
        graders: [{ id: "steps" }],
        timeoutSec: 120,
        tags: ["e2e"],
        placement: { target: `self:ws:${runner.id}` }, // ← workspace-shared runner
      },
    }),
  });
  console.log(`▶ submitted run ${submitted.id} → self:ws:${runner.id}`);
  let rec;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    rec = await api(`/runs/${submitted.id}`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  if (rec.status !== "succeeded") throw new Error(`run ${rec.status}: ${JSON.stringify(rec.error)}`);
  const prov = rec.result?.provenance;
  if (prov?.ranOn !== "self-hosted" || prov.runner !== runner.id)
    throw new Error(`✗ provenance mismatch: ${JSON.stringify(prov)}`);
  if (prov.by !== `ws:${WS}`)
    throw new Error(`✗ not workspace-billed (by=${prov.by}, expected ws:${WS}) — a team runner tagged as own-pays`);
  console.log(`✓ run ${rec.id} ← ran on the team runner (${prov.runner}), billed by=${prov.by} (workspace-billed)`);

  // 4) cross-workspace isolation: if another workspace (team-b) targets the same self:ws:<id>, it resolves to that workspace's
  //    shared runner (owner=ws:team-b), which does not exist → NOT_FOUND — a team runner is exclusive to its owning workspace.
  const crossSubmit = await api("/runs", {
    method: "POST",
    headers: { "x-everdict-tenant": "team-b" },
    body: JSON.stringify({
      harness: { id: "scripted", version: "0" },
      case: {
        id: "e2e-cross-ws",
        env: { kind: "repo", source: { files: {} } },
        task: "say hi",
        graders: [{ id: "steps" }],
        timeoutSec: 60,
        tags: ["e2e"],
        placement: { target: `self:ws:${runner.id}` },
      },
    }),
  });
  let cross;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    cross = await api(`/runs/${crossSubmit.id}`, { headers: { "x-everdict-tenant": "team-b" } });
    if (cross.status === "succeeded" || cross.status === "failed") break;
  }
  if (cross.status !== "failed")
    throw new Error(
      `✗ cross-workspace isolation failed — team-b hijacked default's team runner (status=${cross.status})`,
    );
  console.log(
    `✓ cross-workspace isolation — team-b cannot target default's team runner (run ${cross.status}: NOT_FOUND)`,
  );

  console.log(
    `✓ PASS — workspace-shared runner self:ws:${runner.id}: team execution + workspace-billed + cross-ws isolation`,
  );
} finally {
  cleanup();
}
process.exit(0);
