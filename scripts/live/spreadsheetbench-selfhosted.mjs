// Live e2e: **run SpreadsheetBench (v1+v2) samples with codex on a self-hosted runner → grade**.
// Applies the spreadsheetbench bundle (examples/bundles/spreadsheetbench) and runs the two self-contained xlsx samples (v1/v2) with real codex.
// Isomorphic to codex-pinch-selfhosted.mjs — only the harness/benchmark is swapped to SpreadsheetBench.
//   ① dev control plane (in-memory, no-auth) ② POST /runners pairing ③ everdict runner --pair (codex on PATH)
//   ④ POST /bundles/apply (spreadsheetbench) ⑤ run each sample dataset × codex × self:<id> ⑥ poll → tests_pass verdict.
// Each sample installs openpyxl in setup and generates the input xlsx → codex writes output.xlsx → the grader compares cells.
// Usage: node scripts/live/spreadsheetbench-selfhosted.mjs (apps/api/dist + apps/cli/dist built, codex login required)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8795";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();

const bundle = JSON.parse(
  readFileSync(new URL("../../examples/bundles/spreadsheetbench/bundle.json", import.meta.url)),
);

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

  console.log("\n=== ② POST /runners (pair this machine) ===");
  const paired = await post("/runners", { label: "sbench-laptop", capabilities: ["repo"] });
  const token = paired.json.token;
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!token || !runnerId) throw new Error("pairing failed");

  console.log("\n=== ③ everdict runner --pair (codex on PATH) ===");
  runner = spawn(
    "node",
    ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "1000"],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  console.log("\n=== ④ POST /bundles/apply (spreadsheetbench) ===");
  const inst = await post("/bundles/apply", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  const samples = [
    { dataset: "spreadsheetbench-v1-sample", label: "v1(sum→D1)" },
    { dataset: "spreadsheetbench-v2-sample", label: "v2(Profit column+total, preserve original)" },
  ];
  const outcomes = [];
  for (const s of samples) {
    console.log(`\n=== ⑤ POST /scorecards (${s.dataset} × codex × self:${runnerId}) — ${s.label} ===`);
    const run = await post("/scorecards", {
      dataset: { id: s.dataset, version: "1.0.0" },
      harness: { id: "codex" },
      runtime: `self:${runnerId}`,
    });
    const scId = run.json.id;
    console.log(`  → ${run.status} id=${scId ?? "-"}`);
    if (!scId) {
      console.log(`  ⚠️ submit failed: ${JSON.stringify(run.json)}`);
      outcomes.push(false);
      continue;
    }
    let rec;
    for (let i = 0; i < 240; i++) {
      await sleep(2000);
      rec = await get(`/scorecards/${scId}`);
      process.stdout.write(`  status=${rec.status}\r`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    const c = rec.scorecard?.results?.[0];
    const prov = c?.provenance;
    const tp = c?.scores?.find((x) => x.metric === "tests_pass");
    console.log(
      `\n  final status=${rec.status} · ranOn=${prov?.ranOn ?? "-"} · tests_pass=${tp ? (tp.pass ? "PASS" : "FAIL") : "(none)"}`,
    );
    if (tp && !tp.pass && typeof tp.detail === "string") console.log(`    detail: ${tp.detail.slice(0, 300)}`);
    outcomes.push(rec.status === "succeeded" && !!tp?.pass);
  }

  ok = outcomes.every(Boolean) && outcomes.length === samples.length;
  console.log(
    ok
      ? "\n✅ Both SpreadsheetBench v1+v2 samples ran with self-hosted codex → tests_pass PASS. Bundle registration + execution verified."
      : `\n⚠️ Some samples mismatched: ${JSON.stringify(outcomes)} (see logs above).`,
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
