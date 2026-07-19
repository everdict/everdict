// Live e2e: **run SpreadsheetBench with the codex-in-image harness**. codex solves it inside the image (spreadsheetbench-codex:v1)
// using the machine ChatGPT login (the runner mounts ~/.codex, own-pays), and formula outputs are recalc'd with in-image LibreOffice before grading.
// Demonstrates portable-harness-runtime slice 1 (runner case.image → local Docker) + mount (codex login).
//   ① dev control plane (in-memory) ② POST /runners ③ everdict runner --pair --mount-codex-login (codex on PATH)
//   ④ POST /bundles/apply (spreadsheetbench: sbench-codex harness + codex sample) ⑤ sample × sbench-codex × self:<id> ⑥ tests_pass.
// Prereqs: docker + `docker build -t spreadsheetbench-codex:v1 -f examples/bundles/spreadsheetbench/Dockerfile.codex ...`,
//       machine codex login (~/.codex), apps/api/dist + apps/cli/dist built.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8804";
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

  console.log("\n=== ② POST /runners ===");
  const paired = await post("/runners", { label: "codex-image", capabilities: ["git"] });
  const runnerId = paired.json.runner?.id;
  console.log(`  → ${paired.status} runnerId=${runnerId}`);
  if (!paired.json.token || !runnerId) throw new Error("pairing failed");

  console.log("\n=== ③ everdict runner --pair --mount-codex-login (codex on PATH) ===");
  runner = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      paired.json.token,
      "--api-url",
      BASE,
      "--poll-interval-ms",
      "1000",
      "--mount-codex-login",
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  runner.stderr.on("data", (d) => process.stderr.write(`  [runner] ${d}`));
  runner.stdout.on("data", (d) => process.stdout.write(`  [runner] ${d}`));
  await sleep(3000);

  console.log("\n=== ④ POST /bundles/apply (spreadsheetbench: sbench-codex + codex sample) ===");
  const inst = await post("/bundles/apply", bundle);
  for (const r of inst.json.results ?? []) console.log(`  ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);

  console.log(`\n=== ⑤ POST /scorecards (codex sample × sbench-codex × self:${runnerId}) ===`);
  const run = await post("/scorecards", {
    dataset: { id: "spreadsheetbench-v1-codex-sample", version: "1.0.0" },
    harness: { id: "sbench-codex", version: "1.0.0" },
    runtime: `self:${runnerId}`,
  });
  const scId = run.json.id;
  console.log(`  → ${run.status} id=${scId ?? "-"}`);
  if (!scId) throw new Error(`submit failed: ${JSON.stringify(run.json)}`);

  console.log("\n=== ⑥ polling (codex solves inside the image with the machine login, then recalc grading) ===");
  let rec;
  for (let i = 0; i < 200; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${scId}`);
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  const c = rec.scorecard?.results?.[0];
  const prov = c?.provenance;
  const tp = c?.scores?.find((s) => s.metric === "tests_pass");
  console.log(
    `\n  final status=${rec.status} · ranOn=${prov?.ranOn ?? "-"} · tests_pass=${tp ? (tp.pass ? "PASS" : "FAIL") : "(none)"}`,
  );
  if (tp && !tp.pass && typeof tp.detail === "string") console.log(`    detail: ${tp.detail.slice(0, 300)}`);
  ok = rec.status === "succeeded" && !!tp?.pass;
  console.log(
    ok
      ? "\n✅ Ran SpreadsheetBench with the codex-in-image harness → tests_pass PASS. In-image codex (machine login mounted) + LibreOffice recalc grading."
      : "\n⚠️ Mismatch vs expected (see logs above — check codex login / image / docker).",
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
