// Live e2e: self-hosted runner. A member pulls the workspace's job onto their own machine (this process), runs it,
// and returns the result (push→pull). Runs the workspace's shared harness/dataset "just by swapping the runtime" (self:<runnerId>) on my host.
// Verify: pairing → start everdict runner → submit run with runtime=self:<id> → succeeded + result.provenance.ranOn=self-hosted.
// Design: docs/architecture/self-hosted-runner.md.
//
// Prereqs:
//   pnpm build
//   node apps/api/dist/main.js            # control plane API (:8787, in-memory, dev fallback auth)
// Usage:
//   node scripts/live/self-hosted-runner.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
// dev fallback (unauthenticated) → subject=dev, workspace=default. The runner is paired under the same dev owner, so self: routing lines up.
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// 1) device pairing → rnr_ token (shown once).
const { runner, token } = await api("/runners", {
  method: "POST",
  body: JSON.stringify({ label: "e2e-laptop", capabilities: ["repo"] }),
});
console.log(`▶ paired runner ${runner.id} (${runner.label})`);

// 2) start this machine as a runner (everdict runner). Authenticates to /mcp with the pairing token.
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
  await sleep(2500); // wait for the runner's MCP connection

  // In a single workspace (x-everdict-tenant header), run with runtime=self:<id> and verify the result.
  // scripted harness — local, no external deps (runs on this machine). With dev fallback subject="dev", the owner is the same even across different workspaces.
  const runOnSelf = async (workspace) => {
    const wsHeaders = { "x-everdict-tenant": workspace };
    const submitted = await api("/runs", {
      method: "POST",
      headers: wsHeaders,
      body: JSON.stringify({
        harness: { id: "scripted", version: "0" },
        case: {
          id: `e2e-${workspace}`,
          env: { kind: "repo", source: { files: {} } },
          task: "say hi",
          graders: [{ id: "steps" }],
          timeoutSec: 120,
          tags: ["e2e"],
          placement: { target: `self:${runner.id}` }, // ← "just swap the runtime" — my local host
        },
      }),
    });
    console.log(`▶ [${workspace}] submitted run ${submitted.id} → self:${runner.id}`);
    let rec;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      rec = await api(`/runs/${submitted.id}`, { headers: wsHeaders });
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    if (rec.status !== "succeeded") throw new Error(`[${workspace}] run ${rec.status}: ${JSON.stringify(rec.error)}`);
    const prov = rec.result?.provenance;
    if (prov?.ranOn !== "self-hosted" || prov.runner !== runner.id || prov.by !== "dev")
      throw new Error(`[${workspace}] ✗ provenance mismatch: ${JSON.stringify(prov)}`);
    console.log(
      `✓ [${workspace}] run ${rec.id} (tenant=${rec.tenant}) ← ran on the same runner (${prov.runner}), tagged`,
    );
    return rec;
  };

  // 3) one run in the default workspace.
  await runOnSelf("default");

  // 4) cross-workspace: the same runner also takes a job from another workspace (team-b) (a runner serves the owner's multiple workspaces from one queue).
  const other = await runOnSelf("team-b");
  if (other.tenant !== "team-b") throw new Error("✗ the second run's workspace is not team-b");

  console.log(
    `✓ PASS — one runner (${runner.id}) ran jobs from both the default and team-b workspaces and tagged each to its workspace`,
  );
} finally {
  cleanup();
}
process.exit(0);
