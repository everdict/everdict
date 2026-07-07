// Live e2e: personal runner pool (self). Attach 2 of my runners and submit to self without a runner id — any of my runners takes it
// (multiple processes/machines in one personal pool). Personal version of the workspace pool (self:ws) — owner=submitter, own-pays.
// Verify: POST /runners x2 → everdict runner x2 → N jobs with runtime=self → all succeeded, ranBy is one of my runners, by=submitter.
// Design: docs/architecture/self-hosted-runtime-and-runners.md (slice 2).
//
// Setup: pnpm build && node apps/api/dist/main.js
// Usage: node scripts/live/personal-pool.mjs
import { spawn } from "node:child_process";
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-everdict-tenant": "default", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};

// Pair 2 personal runners (owner=dev, dev fallback). POST /runners = personally owned.
const pair = async (label) => {
  const { runner, token } = await api("/runners", {
    method: "POST",
    body: JSON.stringify({ label, capabilities: ["git"] }),
  });
  return { id: runner.id, token };
};
const r1 = await pair("mine-a");
const r2 = await pair("mine-b");
console.log(`▶ paired 2 personal runners: ${r1.id}, ${r2.id}`);

const procs = [r1, r2].map((r) =>
  spawn(
    process.execPath,
    ["apps/cli/dist/main.js", "runner", "--pair", r.token, "--api-url", B, "--poll-interval-ms", "500"],
    { stdio: "inherit" },
  ),
);
const cleanup = () => {
  for (const p of procs) if (!p.killed) p.kill("SIGINT");
};
process.on("exit", cleanup);

try {
  await sleep(2500);
  const N = 4;
  const submit = (i) =>
    api("/runs", {
      method: "POST",
      body: JSON.stringify({
        harness: { id: "scripted", version: "0" },
        case: {
          id: `mine-${i}`,
          env: { kind: "repo", source: { files: {} } },
          task: "say hi",
          graders: [{ id: "steps" }],
          timeoutSec: 120,
          tags: ["e2e"],
          placement: { target: "self" }, // ← personal pool (no runner id)
        },
      }),
    }).then((r) => r.id);
  const runIds = await Promise.all(Array.from({ length: N }, (_, i) => submit(i)));
  console.log(`▶ submitted ${N} runs → self (personal pool)`);

  const ranOn = new Set();
  for (const id of runIds) {
    let rec;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      rec = await api(`/runs/${id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    if (rec.status !== "succeeded") throw new Error(`run ${id} ${rec.status}: ${JSON.stringify(rec.error)}`);
    const prov = rec.result?.provenance;
    if (prov?.ranOn !== "self-hosted") throw new Error(`run ${id} is not self-hosted: ${JSON.stringify(prov)}`);
    if (prov.by !== "dev") throw new Error(`a personal pool must be own-pays (by=submitter), but by=${prov.by}`);
    ranOn.add(prov.runner);
  }
  const known = new Set([r1.id, r2.id]);
  for (const id of ranOn) if (!known.has(id)) throw new Error(`unknown runner handled it: ${id}`);
  console.log(`✓ all ${N} runs succeeded (self-hosted, by=dev/own-pays); runners that ran: ${[...ranOn].join(", ")}`);
  console.log(
    "✓ PASS — self (personal pool) routes to my runners (owner=submitter). Distribution completeness is proven by the unit test.",
  );
} finally {
  cleanup();
}
process.exit(0);
