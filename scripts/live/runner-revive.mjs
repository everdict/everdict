// Live RUNNER-REVIVE torture: the hard requirement — a batch must reach ALL-PASS across a runner death by
// re-running the orphaned cases on a revived/replacement runner, and a case must NEVER just pend forever.
//
//   RV1 revive & complete — a pool's sole runner is SIGKILLed mid-batch; a NEW runner is then paired and
//                           started. The requeued cases re-run on it and the batch completes 8/8 (the
//                           parked cases move instantly; a case leased-at-death moves after the lease TTL).
//   RV2 no eternal pending — the pool has a CAPABLE runner (docker/topology) and an INCAPABLE survivor
//                           (git only) kept busy heartbeating a parallel command batch. The capable runner
//                           is killed mid-topology-batch; pre-fix the survivor's heartbeats kept the
//                           orphaned topology cases alive forever (leased by no one, never timing out).
//                           Post-fix they don't — and once a capable runner is revived the batch completes
//                           8/8. The command batch on the survivor finishes throughout (fleet stays healthy).
//
// Usage: node scripts/live/runner-revive.mjs   (docker + api/cli/self-hosted-runner dists built). ~8 min.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PORT = process.env.CP_PORT ?? "8806";
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
const waitTerminal = async (id, seconds) => {
  let rec;
  for (let i = 0; i < seconds / 2; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${id}`);
    if (rec.status === "succeeded" || rec.status === "failed" || rec.status === "cancelled") return rec;
  }
  return rec;
};
const allPass = (rec) =>
  (rec.scorecard?.results ?? []).length === 8 &&
  (rec.scorecard?.results ?? []).every((r) => (r.scores ?? []).some((s) => s.pass));

const TOPO = (extra = {}) => ({
  dataset: { id: "sse-relay-parallel", version: "1.0.0" },
  harness: { id: "sse-relay-bench" },
  runtime: "self",
  concurrency: 2,
  retries: 3, // absorb transient no_runner during the recovery window — the batch must still reach all-pass
  ...extra,
});

console.log("=== ⓪ images + clean slate ===");
// Build only what's missing — a present tag lets the suite run through a Docker Hub outage (base-image pull).
const have = (tag) => {
  try {
    sh("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ensureImage = (tag, args) => {
  if (have(tag)) return console.log(`  reusing ${tag}`);
  sh("docker", ["build", "-q", "-t", tag, ...args], { stdio: "inherit" });
};
ensureImage("sse-relay-command:v1", [`${BUNDLE_DIR}/command-server`]);
ensureImage("sse-relay-relay:v1", [`${BUNDLE_DIR}/relay-server`]);
ensureImage("sse-relay-client-host:v1", ["-f", `${BUNDLE_DIR}/client-host/Dockerfile`, BUNDLE_DIR]);
const leftover = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
if (leftover) sh("docker", ["rm", "-f", ...leftover.split("\n")], { stdio: "ignore" });
try {
  sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
} catch {}

console.log(`\n=== ① control plane (:${PORT}, idle-timeout 90s) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    EVERDICT_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: "",
    EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS: "90000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
const runners = []; // { proc?, host?, id, label }
let ok = false;
const pair = async (label) => {
  const paired = await post("/runners", { label, capabilities: ["git"] });
  if (!paired.json.token || !paired.json.runner?.id) throw new Error(`pairing ${label} failed`);
  return paired.json;
};
const startCli = async (label, extra = []) => {
  const p = await pair(label);
  const proc = spawn(
    "node",
    [
      "apps/cli/dist/main.js",
      "runner",
      "--pair",
      p.token,
      "--api-url",
      BASE,
      "--poll-interval-ms",
      "500",
      "--ready-timeout-ms",
      "180000",
      ...extra,
    ],
    { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stderr.on("data", (d) => process.stderr.write(`  [${label}] ${d}`));
  const entry = { proc, id: p.runner.id, label };
  runners.push(entry);
  return entry;
};
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");
  const shr = await import(pathToFileURL(`${ROOT}packages/self-hosted-runner/dist/index.js`).href);

  // ── RV1: sole runner dies, a NEW runner revives the batch ──────────────────
  console.log("\n=== ② RV1 — sole runner SIGKILLed mid-batch → new runner completes it ===");
  const sole = await startCli("rv1-sole", ["--max-concurrent", "2"]);
  await sleep(3000);
  for (const file of ["bundle.json", "stress-bundle.json"]) {
    const applied = await post("/bundles/apply", JSON.parse(readFileSync(`${BUNDLE_DIR}/${file}`, "utf8")));
    if ((applied.json.results ?? []).some((r) => r.status === "failed")) throw new Error(`${file} apply failed`);
  }
  const warm = await waitTerminal((await post("/scorecards", TOPO({ cases: { limit: 1 } }))).json.id, 300);
  check(warm.status === "succeeded", "RV1: warmup succeeded (topology deployed)");

  const t1 = Date.now();
  const rv1id = (await post("/scorecards", TOPO())).json.id;
  await sleep(12_000); // 2 cases leased + running, 6 parked
  sole.proc.kill("SIGKILL");
  console.log(`  >>> rv1-sole (pid ${sole.proc.pid}) SIGKILLed with cases in flight`);
  await sleep(3000);
  const revived = await startCli("rv1-new", ["--max-concurrent", "4"]);
  console.log(`  >>> paired + started replacement runner ${revived.id.slice(0, 8)}`);
  const rv1 = await waitTerminal(rv1id, 360);
  const rv1min = ((Date.now() - t1) / 60_000).toFixed(1);
  check(rv1.status === "succeeded", `RV1: batch succeeded after the runner death (status=${rv1.status})`);
  check(allPass(rv1), `RV1: all 8 cases pass — orphaned cases re-ran on the replacement (wall ${rv1min}m)`);
  const rv1OnNew = (rv1.scorecard?.results ?? []).filter((r) => r.provenance?.runner === revived.id).length;
  check(rv1OnNew > 0, `RV1: the replacement runner actually executed cases (${rv1OnNew})`);

  // ── RV2: incapable survivor must NOT trap the orphaned batch; a revived capable finishes it ─────────
  console.log("\n=== ③ RV2 — capable runner dies; incapable survivor busy; a capable revive completes it ===");
  // Incapable survivor: a stock CLI runner (advertises git/docker via its own probe) would be capable, so we
  // simulate an INCAPABLE-for-topology runner via RunnerHost with an explicit capability set lacking docker.
  const survivor = new shr.RunnerHost({
    apiUrl: BASE,
    token: (await pair("rv2-incap")).token,
    maxConcurrent: 4,
    capabilities: ["git"], // no docker/browser/topology → cannot run the topology batch
    log: (m) => process.stderr.write(`  [rv2-incap] ${m}\n`),
  });
  await survivor.start();
  const capable = await startCli("rv2-cap", ["--max-concurrent", "2"]);
  await sleep(3000);
  // Keep the incapable survivor BUSY + heartbeating throughout (a parallel command batch it CAN run).
  const cmdBatch = post("/scorecards", {
    dataset: { id: "sh-echo-parallel", version: "1.0.0" },
    harness: { id: "sh-bench" },
    runtime: "self",
    concurrency: 4,
    trials: 6, // 48 quick cases → the survivor stays busy heartbeating across the whole RV2 window
  }).then((r) => waitTerminal(r.json.id, 360));

  const t2 = Date.now();
  const rv2id = (await post("/scorecards", TOPO())).json.id;
  await sleep(12_000);
  capable.proc.kill("SIGKILL");
  console.log("  >>> rv2-cap (the only topology-capable runner) SIGKILLed; incapable survivor keeps heartbeating");
  await sleep(20_000); // pre-fix: the survivor's heartbeats keep the orphaned cases alive forever (would hang here)
  const rv2capable2 = await startCli("rv2-cap2", ["--max-concurrent", "4"]);
  console.log(`  >>> revived a capable runner ${rv2capable2.id.slice(0, 8)}`);
  const rv2 = await waitTerminal(rv2id, 360);
  const rv2min = ((Date.now() - t2) / 60_000).toFixed(1);
  check(rv2.status === "succeeded", `RV2: topology batch reached terminal (status=${rv2.status}) — not stuck pending`);
  check(allPass(rv2), `RV2: all 8 cases pass on the revived capable runner (wall ${rv2min}m)`);
  const cmdRec = await cmdBatch;
  check(cmdRec.status === "succeeded", "RV2: the survivor's command batch completed throughout (fleet healthy)");

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — a batch reaches all-pass across a runner death by re-running on a revived runner, and no case is ever left pending forever."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const r of runners) {
    try {
      r.proc?.kill("SIGKILL");
    } catch {}
  }
  if (!process.env.KEEP) {
    try {
      const names = sh("docker", ["ps", "-aq", "--filter", `name=${NETWORK}`]).trim();
      if (names) sh("docker", ["rm", "-f", ...names.split("\n")], { stdio: "ignore" });
      sh("docker", ["network", "rm", NETWORK], { stdio: "ignore" });
    } catch {}
  }
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
