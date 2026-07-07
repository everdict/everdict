// Live e2e: *one-shot bundle apply* → run the pinch benchmark → **leaderboard (harness × model)**.
// User scenario (multi-tenant SaaS, HTTP API only):
//   ① POST /bundles/apply : register the codex (harness) + pinch (benchmark) bundle at once — generalized self-serve registration.
//   ② POST /scorecards      : run pinch as the harness (judge-scored). codex needs its CLI+runtime, so
//      the default runs the builtin 'scripted' to prove out the whole apply→run→leaderboard loop with no external dependency.
//      For an actual codex run, swap to EVERDICT_HARNESS=codex + a docker runtime (codex-provisioned image) (see comment below).
//   ③ GET /scorecards/leaderboard : print a benchmark's (harness × model) ranking rows.
// Judge scoring needs a model → inject the LiteLLM(:4000) key into the CP judge env (same as pinch-hermes-e2e).
//
// Usage: node scripts/live/codex-pinch-leaderboard.mjs   (needs apps/api/dist built; judge scores for real if LiteLLM is present)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8789";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const HARNESS = process.env.EVERDICT_HARNESS ?? "scripted"; // for an actual codex run: EVERDICT_HARNESS=codex + EVERDICT_RUNTIME=<codex-image docker runtime>
const RUNTIME = process.env.EVERDICT_RUNTIME; // if unset, the default backend (scripted runs in-process on the host)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function litellmKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    return (readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8").match(
      /^LITELLM_MASTER_KEY=(.+)$/m,
    ) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = litellmKey();
const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (path) => (await fetch(`${BASE}${path}`, { headers: H })).json();

const bundle = JSON.parse(readFileSync(new URL("../../examples/bundles/codex-pinch/bundle.json", import.meta.url)));

console.log(`=== start control plane (apps/api dist, dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT,
    EVERDICT_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: "",
    ...(KEY ? { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1" } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));

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

  // ① one-shot bundle apply
  console.log("\n=== ① POST /bundles/apply (codex + pinch bundle) ===");
  const inst = await post("/bundles/apply", bundle);
  console.log(`  → ${inst.status}`);
  for (const r of inst.json.results ?? []) console.log(`     ${r.status.padEnd(8)} ${r.kind} ${r.id}@${r.version}`);
  const installOk =
    inst.status === 200 && (inst.json.results ?? []).every((r) => r.status === "ok" || r.status === "conflict");

  // ② run pinch (judge-scored). Default scripted (no external dependency); real codex via EVERDICT_HARNESS=codex + EVERDICT_RUNTIME.
  console.log(`\n=== ② POST /scorecards (pinch-building-dashboards × ${HARNESS}) ===`);
  const run = await post("/scorecards", {
    dataset: { id: "pinch-building-dashboards", version: "1.0.0" },
    harness: { id: HARNESS },
    ...(RUNTIME ? { runtime: RUNTIME } : {}),
    ...(KEY ? { judge: { provider: "openai", model: process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini" } } : {}),
  });
  console.log(`  → ${run.status} id=${run.json.id ?? "-"}`);
  let rec = run.json;
  if (run.json.id) {
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      rec = await get(`/scorecards/${run.json.id}`);
      process.stdout.write(`  status=${rec.status}\r`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    console.log(
      `\n  final status=${rec.status}${rec.models?.primary ? ` model=${rec.models.primary}` : " model=unknown"}`,
    );
  }

  // ③ leaderboard
  console.log("\n=== ③ GET /scorecards/leaderboard (pinch-building-dashboards × harness×model) ===");
  const lb = await get("/scorecards/leaderboard?dataset=pinch-building-dashboards&metric=judge");
  for (const row of lb.rows ?? [])
    console.log(
      `  #${row.rank} ${row.harness.id}@${row.harness.version} × ${row.model ?? "unknown"} — score=${row.score ?? "–"} (runs=${row.runs})`,
    );

  ok = installOk && (lb.rows ?? []).length > 0;
  console.log(
    ok
      ? "\n✅ Proved out the apply(one-shot bundle) → run(pinch) → leaderboard(harness×model) loop. Swap to codex via EVERDICT_HARNESS=codex + EVERDICT_RUNTIME=<codex docker runtime>."
      : "\n⚠️ some steps mismatched (see logs above). Real judge scoring needs LiteLLM(:4000); running codex needs a codex-provisioned runtime.",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
