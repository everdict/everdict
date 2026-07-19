// Live e2e: **run pinch with codex on a self-hosted runner → leaderboard**. Driven by the real codex CLI (machine ChatGPT login).
// Flow (multi-tenant SaaS, HTTP API only):
//   ① start dev control plane (in-memory, no auth required).
//   ② POST /runners : pair this machine as a runner → rnr_ token.
//   ③ everdict runner --pair : start the runner process (codex must be on PATH — LocalDriver runs in-process).
//   ④ POST /bundles/apply : one-shot apply of the codex harness + pinch benchmark bundle.
//   ⑤ POST /scorecards {dataset: pinch-dashboards, harness: codex, runtime: self:<id>} : run self-hosted.
//   ⑥ poll → provenance (ranOn=self-hosted) + case verdict + print GET /scorecards/leaderboard rows.
// codex does not draw down the workspace budget (the machine login pays).
//
// Usage: node scripts/live/codex-pinch-selfhosted.mjs   (needs apps/api/dist + apps/cli/dist built; codex login required)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8790";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();

const bundle = JSON.parse(readFileSync(new URL("../../examples/bundles/codex-pinch/bundle.json", import.meta.url)));

console.log(`=== ① start control plane (dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
let runner;
let ok = false;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  // ② pair the runner
  console.log("\n=== ② POST /runners (pair this machine) ===");
  const paired = await post("/runners", { label: "codex-laptop", capabilities: ["git"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error("pairing failed");

  // ③ start the runner process — codex must be on PATH (LocalDriver in-process). Runner owner = dev (same as the scorecard submitter).
  console.log("\n=== ③ everdict runner --pair (codex on PATH) ===");
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000); // wait for the runner MCP session to connect

  // ④ apply the bundle (codex + pinch)
  console.log("\n=== ④ POST /bundles/apply (codex + pinch) ===");
  const inst = await post("/bundles/apply", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  // ⑤ run pinch-dashboards as codex × self-hosted
  console.log(`\n=== ⑤ POST /scorecards (pinch-dashboards × codex × self:${runnerId}) ===`);
  const run = await post("/scorecards", {
    dataset: { id: "pinch-dashboards", version: "1.0.0" },
    harness: { id: "codex" },
    runtime: `self:${runnerId}`,
  });
  console.log(`  → ${run.status} id=${run.json.id ?? "-"}`);
  const scId = run.json.id;
  if (!scId) throw new Error(`scorecard submit failed: ${JSON.stringify(run.json)}`);

  // ⑥ poll (codex run ~1-2 min) → result
  console.log("\n=== ⑥ polling (codex is writing dashboard.json on the self-hosted runner…) ===");
  let rec;
  for (let i = 0; i < 200; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${scId}`);
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  final status=${rec.status}`);
  const c = rec.scorecard?.results?.[0];
  const prov = c?.provenance;
  const tp = c?.scores?.find((s) => s.metric === "tests_pass");
  console.log(`  provenance: ${JSON.stringify(prov)}`); // expect ranOn=self-hosted
  console.log(`  tests_pass: ${tp ? (tp.pass ? "PASS" : "FAIL") : "(none)"}`);
  console.log(`  models: ${JSON.stringify(rec.models)}`); // declared gpt-5-codex

  const lb = await get("/scorecards/leaderboard?dataset=pinch-dashboards&metric=tests_pass");
  console.log("\n=== leaderboard (pinch-dashboards × harness×model) ===");
  for (const row of lb.rows ?? [])
    console.log(
      `  #${row.rank} ${row.harness.id}@${row.harness.version} × ${row.model ?? "unknown"} — score=${row.score ?? "–"} (runs=${row.runs})`,
    );

  ok = rec.status === "succeeded" && prov?.ranOn === "self-hosted" && (lb.rows ?? []).length > 0;
  console.log(
    ok
      ? "\n✅ codex ran pinch on a self-hosted runner → leaderboard. The machine codex login pays (workspace budget untouched)."
      : "\n⚠️ mismatch vs expected (see logs above). Check codex login/PATH or python3.",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  try {
    runner?.kill("SIGKILL");
  } catch {}
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
