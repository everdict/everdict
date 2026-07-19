// Live e2e: **cold-start deploy race** — 4 runner PROCESSES (2 workers each) take an 8-case topology
// scorecard with NO warmup, so all four processes hit ensureTopology for the same version at once on a
// cold daemon. Pre-fix this raced: every process rm -f'd the fixed-name containers the others were
// mid-deploying (mutual destruction, cascade failures). Post-fix, `docker network create` is the
// cross-process mutex — exactly one process deploys, the losers wait-adopt.
//
// Proves: 8/8 cases pass with zero dispatch failures on a fully cold start; exactly ONE topology
// (one network, one 4-container set) exists afterwards; at least two processes executed cases.
//
// Usage: node scripts/live/sse-relay-coldstart-race.mjs   (docker + api/cli dists built)
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8797";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const NETWORK = "everdict-sse-relay-bench-1.0.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

console.log("=== ⓪ build images + ensure a COLD daemon (no topology leftovers) ===");
sh("docker", ["build", "-q", "-t", "sse-relay-command:v1", `${BUNDLE_DIR}/command-server`], { stdio: "inherit" });
sh("docker", ["build", "-q", "-t", "sse-relay-relay:v1", `${BUNDLE_DIR}/relay-server`], { stdio: "inherit" });
sh(
  "docker",
  ["build", "-q", "-t", "sse-relay-client-host:v1", "-f", `${BUNDLE_DIR}/client-host/Dockerfile`, BUNDLE_DIR],
  { stdio: "inherit" },
);
const leftover = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
if (leftover) sh("docker", ["rm", "-f", ...leftover.split("\n")], { stdio: "ignore" });
try {
  sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
} catch {}

console.log(`\n=== ① control plane (dev, :${PORT}) + 4 runner processes (2 workers each) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
const procs = [];
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

  const runnerIds = [];
  for (let i = 0; i < 4; i++) {
    const paired = await post("/runners", { label: `cold-${i}`, capabilities: ["git"] });
    if (!paired.json.token || !paired.json.runner?.id) throw new Error(`pairing ${i} failed`);
    runnerIds.push(paired.json.runner.id);
    const proc = spawn(
      "node",
      [
        "apps/cli/dist/main.js",
        "runner",
        "--pair",
        paired.json.token,
        "--api-url",
        BASE,
        "--max-concurrent",
        "2",
        "--poll-interval-ms",
        "300",
        "--ready-timeout-ms",
        "180000",
      ],
      { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stderr.on("data", (d) => process.stderr.write(`  [r${i}] ${d}`));
    procs.push(proc);
  }
  await sleep(3000);

  console.log("\n=== ② apply bundle + submit 8 cases COLD (no warmup — all four processes deploy-race) ===");
  const applied = await post("/bundles/apply", JSON.parse(readFileSync(`${BUNDLE_DIR}/bundle.json`, "utf8")));
  if ((applied.json.results ?? []).some((r) => r.status === "failed")) throw new Error("bundle apply failed");
  const sub = await post("/scorecards", {
    dataset: { id: "sse-relay-parallel", version: "1.0.0" },
    harness: { id: "sse-relay-bench" },
    runtime: "self",
    concurrency: 8,
  });
  if (!sub.json.id) throw new Error(`submit failed: ${JSON.stringify(sub.json)}`);
  let rec;
  for (let i = 0; i < 240; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${sub.json.id}`);
    process.stdout.write(`  status=${rec.status} settled=${rec.scorecard?.results?.length ?? 0}/8   \r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  final status=${rec.status}`);

  console.log("\n=== ③ verdict ===");
  const results = rec.scorecard?.results ?? [];
  check(rec.status === "succeeded", "scorecard succeeded on a fully cold start");
  check(results.length === 8, `8 case results (got ${results.length})`);
  for (const r of results) {
    const am = (r.scores ?? []).find((s) => s.graderId === "answer-match");
    check(am?.pass === true, `${r.caseId}: answer-match pass (${String(am?.detail ?? "-").slice(0, 60)})`);
  }
  const usedRunners = new Set(results.map((r) => r.provenance?.runner).filter(Boolean));
  check(usedRunners.size >= 2, `multiple processes executed cases (${usedRunners.size} distinct runners)`);
  const nets = sh("docker", ["network", "ls", "--format", "{{.Name}}"])
    .trim()
    .split("\n")
    .filter((n) => n.startsWith("everdict-sse-relay-bench"));
  const containers = sh("docker", ["ps", "--format", "{{.Names}}"])
    .trim()
    .split("\n")
    .filter((n) => n.startsWith(NETWORK));
  check(nets.length === 1, `exactly ONE topology network after the race (got ${nets.length})`);
  check(containers.length === 4, `exactly ONE container set after the race (got ${containers.length})`);

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — four processes cold-started the same topology: one deployed, the rest adopted, 8/8 clean."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  try {
    cp.kill("SIGKILL");
  } catch {}
  if (!process.env.KEEP) {
    try {
      const names = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
      if (names) sh("docker", ["rm", "-f", ...names.split("\n")], { stdio: "ignore" });
      sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
    } catch {}
  }
}
process.exit(ok ? 0 : 1);
