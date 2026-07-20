// Live NEGATIVE-path torture: scenarios that are SUPPOSED to fail — the contract under test is that
// every failure is FAST, EXPLICIT, and CORRECTLY CLASSIFIED (never a silent hang), and that the fleet
// survives each one. Companion to orchestration-torture.mjs (happy-path axes under overload).
//
//   N2 unsatisfiable OS   — an os-windows topology submitted to a pool with NO os-windows runner must
//                           fail fast naming the missing capability (not a generic idle timeout);
//   N5 impossible docker  — a topology service demanding --cpus far beyond the host fails the case
//                           immediately with the docker error, and a normal batch runs right after
//                           (no poisoned warm state);
//   N1 unplaceable nomad  — a command harness demanding cpu/memory beyond every node must surface
//                           nomad's blocked evaluation (exhausted dimensions) quickly — not sit in the
//                           30-minute alloc poll (the pre-fix behavior this suite was built to break);
//   N4 auto-shard mix     — runtime:"auto" over a LIVE nomad + a DEAD nomad: the dead lane spills over,
//                           every case passes, the spillover is recorded;
//   N3 zombie runner      — SIGSTOP a runner holding leased cases: the lease TTL requeues them and the
//                           survivors finish the batch; SIGCONT wakes the zombie whose stale
//                           submit_job_result must be rejected without duplicating results.
//
// Usage: node scripts/live/negative-torture.mjs   (docker + api/cli/self-hosted-runner dists built;
//   Nomad at NOMAD_ADDR with the docker driver's image GC disabled + everdict-agent:slim present).
//   ~20 min — N3 waits out the 2-minute lease TTL.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PORT = process.env.CP_PORT ?? "8805";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const NETWORK = "everdict-sse-relay-bench-1.0.0";
const NOMAD = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
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
const caseDetails = (rec) =>
  (rec.scorecard?.results ?? []).map((r) => ({
    id: r.caseId,
    pass: (r.scores ?? []).some((s) => s.pass),
    class: r.failure?.class,
    detail: (r.scores ?? []).map((s) => String(s.detail ?? "")).join(" "),
  }));

console.log("=== ⓪ prerequisites ===");
sh("docker", ["build", "-q", "-t", "sse-relay-command:v1", `${BUNDLE_DIR}/command-server`], { stdio: "inherit" });
sh("docker", ["build", "-q", "-t", "sse-relay-relay:v1", `${BUNDLE_DIR}/relay-server`], { stdio: "inherit" });
sh(
  "docker",
  ["build", "-q", "-t", "sse-relay-client-host:v1", "-f", `${BUNDLE_DIR}/client-host/Dockerfile`, BUNDLE_DIR],
  { stdio: "inherit" },
);
for (const net of [NETWORK, "everdict-sse-relay-monster-1.0.0"]) {
  const leftover = sh("docker", ["ps", "-aq", "--filter", `name=${net}`]).trim();
  if (leftover) sh("docker", ["rm", "-f", ...leftover.split("\n")], { stdio: "ignore" });
  try {
    sh("docker", ["network", "rm", net], { stdio: "ignore" });
  } catch {}
}
let nomadUp = false;
try {
  nomadUp = (await fetch(`${NOMAD}/v1/status/leader`)).ok;
} catch {}
if (!nomadUp) throw new Error("nomad required for N1/N4 — start nomad agent -dev (image GC disabled)");
if (!sh("docker", ["images", "-q", "everdict-agent:slim"]).trim())
  throw new Error("everdict-agent:slim missing — build it (see packages/agent/Dockerfile.slim)");

console.log(`\n=== ① control plane (:${PORT}, idle-timeout 60s) + fleet (2×CLI 1w + RunnerHost 2w) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    EVERDICT_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: "",
    EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS: "60000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
const cliProcs = [];
let host;
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
  const pair = async (label) => {
    const paired = await post("/runners", { label, capabilities: ["git"] });
    if (!paired.json.token || !paired.json.runner?.id) throw new Error(`pairing ${label} failed`);
    return paired.json;
  };
  for (let i = 0; i < 2; i++) {
    const paired = await pair(`neg-cli-${i}`);
    const proc = spawn(
      "node",
      [
        "apps/cli/dist/main.js",
        "runner",
        "--pair",
        paired.token,
        "--api-url",
        BASE,
        "--poll-interval-ms",
        "500",
        "--ready-timeout-ms",
        "180000",
      ],
      { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stderr.on("data", (d) => process.stderr.write(`  [cli${i}] ${d}`));
    cliProcs.push(proc);
  }
  const shr = await import(pathToFileURL(`${ROOT}packages/self-hosted-runner/dist/index.js`).href);
  host = new shr.RunnerHost({
    apiUrl: BASE,
    token: (await pair("neg-desktop")).token,
    maxConcurrent: 2,
    log: (m) => process.stderr.write(`  [desktop] ${m}\n`),
  });
  await host.start();
  await sleep(3000);
  for (const file of ["bundle.json", "stress-bundle.json"]) {
    const applied = await post("/bundles/apply", JSON.parse(readFileSync(`${BUNDLE_DIR}/${file}`, "utf8")));
    if ((applied.json.results ?? []).some((r) => r.status === "failed")) throw new Error(`${file} apply failed`);
  }
  for (const [id, addr] of [
    ["nomad-t", NOMAD],
    ["nomad-dead", "http://127.0.0.1:4747"],
  ]) {
    const r = await post("/runtimes", { kind: "nomad", id, version: "1.0.0", addr, image: "everdict-agent:slim" });
    if (r.status >= 300) throw new Error(`runtime ${id} registration failed`);
  }
  // The resource hog — a command harness no node can hold (100 cores / 1TB).
  await post("/harness-templates", {
    kind: "command",
    category: "cli-agent",
    id: "sh-hog",
    version: "1",
    setup: [],
    command: 'bash -lc "echo hog"',
    env: {},
    resources: { cpu: 100000, memoryMb: 1048576 },
    trace: { kind: "none" },
  });
  await post("/harnesses", { template: { id: "sh-hog", version: "1" }, id: "sh-hog", version: "1.0.0", pins: {} });
  // The impossible-docker topology — one service demanding --cpus 512 on a laptop.
  await post("/harness-templates", {
    kind: "service",
    category: "topology",
    id: "sse-relay-monster",
    version: "1",
    services: [
      {
        name: "command",
        image: "sse-relay-command:v1",
        port: 8000,
        needs: [],
        perRun: [],
        replicas: 1,
        env: {},
        resources: { cpu: 512000 },
      },
    ],
    dependencies: [],
    frontDoor: { service: "command", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://127.0.0.1:9" },
  });
  await post("/harnesses", {
    template: { id: "sse-relay-monster", version: "1" },
    id: "sse-relay-monster",
    version: "1.0.0",
    pins: { command: "sse-relay-command:v1" },
  });
  const warm = await waitTerminal(
    (
      await post("/scorecards", {
        dataset: { id: "sse-relay-parallel", version: "1.0.0" },
        harness: { id: "sse-relay-bench" },
        runtime: "self",
        cases: { limit: 1 },
      })
    ).json.id,
    480,
  );
  check(warm.status === "succeeded", "warmup succeeded (topology deployed)");

  // ── N2 unsatisfiable OS on the pool ─────────────────────────────────────────
  console.log("\n=== N2 — os-windows topology on a pool with NO os-windows runner ===");
  const t2 = Date.now();
  const n2sub = await post("/scorecards", {
    dataset: { id: "sse-relay-parallel", version: "1.0.0" },
    harness: { id: "sse-relay-bench-win" },
    runtime: "self",
    cases: { limit: 2 },
    concurrency: 2,
    retries: 0,
  });
  let n2sec = 0;
  let n2 = { status: "rejected-at-submit" };
  if (n2sub.json.id) {
    n2 = await waitTerminal(n2sub.json.id, 180);
    n2sec = (Date.now() - t2) / 1000;
  } else {
    n2sec = (Date.now() - t2) / 1000;
    n2 = { status: "rejected-at-submit", error: n2sub.json };
  }
  // NB: scorecard status = "the orchestration ran to completion", not the verdict — a batch whose every
  // case failed still reads succeeded. The negative contract is therefore: terminal + every case FAILED
  // fast + the cause named.
  const n2Blob = JSON.stringify(n2.status === "rejected-at-submit" ? n2.error : caseDetails(n2));
  const n2AllFailed =
    n2.status === "rejected-at-submit" || (caseDetails(n2).length > 0 && caseDetails(n2).every((c) => !c.pass));
  check(n2AllFailed, `N2: every unsatisfiable case failed (status=${n2.status})`);
  check(n2sec < 30, `N2: failed FAST (${n2sec.toFixed(0)}s < 30s — not the generic idle timeout)`);
  check(/os-windows/.test(n2Blob), `N2: the missing capability is NAMED (${n2Blob.slice(0, 140)})`);

  // ── N5 impossible docker resources ──────────────────────────────────────────
  console.log("\n=== N5 — topology service demanding --cpus 512 on this host ===");
  const t5 = Date.now();
  const n5 = await waitTerminal(
    (
      await post("/scorecards", {
        dataset: { id: "sse-relay-parallel", version: "1.0.0" },
        harness: { id: "sse-relay-monster" },
        runtime: "self",
        cases: { limit: 1 },
        retries: 0,
      })
    ).json.id,
    240,
  );
  const n5sec = (Date.now() - t5) / 1000;
  const n5d = caseDetails(n5);
  check(n5d.length > 0 && n5d.every((c) => !c.pass), `N5: the monster case failed (status=${n5.status})`);
  check(n5sec < 120, `N5: failed fast (${n5sec.toFixed(0)}s)`);
  check(
    n5d.every((c) => c.class === "infra" && /cpu|CPU|docker/i.test(c.detail)),
    `N5: classified infra with the docker error surfaced (${JSON.stringify(n5d).slice(0, 140)})`,
  );
  const n5after = await waitTerminal(
    (
      await post("/scorecards", {
        dataset: { id: "sse-relay-parallel", version: "1.0.0" },
        harness: { id: "sse-relay-bench" },
        runtime: "self",
        cases: { limit: 2 },
        concurrency: 2,
      })
    ).json.id,
    300,
  );
  check(n5after.status === "succeeded", "N5: a normal topology batch passes right after (no poisoned deploy state)");

  // ── N1 unplaceable nomad resources ──────────────────────────────────────────
  console.log("\n=== N1 — command harness demanding 100 cores / 1TB on nomad ===");
  const t1 = Date.now();
  const n1id = (
    await post("/scorecards", {
      dataset: { id: "sh-echo-parallel", version: "1.0.0" },
      harness: { id: "sh-hog" },
      runtime: "nomad-t",
      cases: { limit: 2 },
      concurrency: 2,
      retries: 0,
    })
  ).json.id;
  let n1 = await waitTerminal(n1id, 200);
  const n1sec = (Date.now() - t1) / 1000;
  if (n1.status === "running") {
    // Pre-fix escape hatch: the 30-minute alloc poll would hold this suite hostage — cancel and record the hang.
    await post(`/scorecards/${n1id}/cancel`, {});
    n1 = await waitTerminal(n1id, 120);
    check(false, `N1: unplaceable batch HUNG >200s (pre-fix 30-min alloc poll) — cancelled to continue`);
  } else {
    const n1d = caseDetails(n1);
    check(n1d.length > 0 && n1d.every((c) => !c.pass), `N1: every unplaceable case failed (status=${n1.status})`);
    check(n1sec < 200, `N1: surfaced in ${n1sec.toFixed(0)}s (not the 30-minute poll)`);
    check(
      n1d.every((c) => /blocked|exhausted|unplaceable|dimension/i.test(c.detail)),
      `N1: nomad's placement verdict is surfaced (${JSON.stringify(n1d).slice(0, 160)})`,
    );
  }
  // nomad leaves the unplaceable job queued server-side — clean it so it never schedules later.
  try {
    const jobs = JSON.parse(sh("curl", ["-s", `${NOMAD}/v1/jobs?prefix=everdict`]));
    for (const j of jobs) sh("curl", ["-s", "-X", "DELETE", `${NOMAD}/v1/job/${j.ID}?purge=true`]);
  } catch {}

  // ── N4 auto-shard over live + dead runtimes ────────────────────────────────
  console.log("\n=== N4 — runtime:auto over a live nomad AND a dead nomad ===");
  const n4 = await waitTerminal(
    (
      await post("/scorecards", {
        dataset: { id: "sh-echo-parallel", version: "1.0.0" },
        harness: { id: "sh-bench" },
        runtime: "auto",
        concurrency: 8,
      })
    ).json.id,
    480,
  );
  const n4pass = (n4.scorecard?.results ?? []).filter((r) => (r.scores ?? []).some((s) => s.pass)).length;
  check(n4.status === "succeeded", `N4: auto-sharded batch succeeded (status=${n4.status})`);
  check(n4pass === 8, `N4: all 8 pass despite the dead shard (${n4pass}/8)`);
  const n4spill = (n4.steps ?? []).filter((s) => /spillover/.test(s.message));
  check(n4spill.length > 0, `N4: spillover recorded (${n4spill.length} step(s), dead → live)`);

  // ── N3 zombie runner ────────────────────────────────────────────────────────
  console.log("\n=== N3 — SIGSTOP a runner mid-batch; TTL requeue; zombie's stale result rejected ===");
  const n3id = (
    await post("/scorecards", {
      dataset: { id: "sse-relay-parallel", version: "1.0.0" },
      harness: { id: "sse-relay-bench" },
      runtime: "self",
      concurrency: 4,
    })
  ).json.id;
  await sleep(10_000); // cases leased across the fleet
  const zombiePid = cliProcs[0].pid;
  process.kill(zombiePid, "SIGSTOP");
  console.log(`  >>> cli0 (pid ${zombiePid}) frozen with cases in flight`);
  const n3 = await waitTerminal(n3id, 480); // lease TTL (2 min) + re-runs
  check(n3.status === "succeeded", `N3: batch completed despite the frozen runner (status=${n3.status})`);
  const n3results = n3.scorecard?.results ?? [];
  check(n3results.length === 8, `N3: exactly 8 results (got ${n3results.length})`);
  check(
    n3results.every((r) => (r.scores ?? []).some((s) => s.pass)),
    "N3: all 8 pass (requeued cases re-ran on survivors)",
  );
  process.kill(zombiePid, "SIGCONT");
  console.log("  >>> zombie thawed — its in-flight case will finish and submit a STALE result");
  await sleep(25_000);
  const n3after = await get(`/scorecards/${n3id}`);
  check(
    (n3after.scorecard?.results ?? []).length === 8,
    `N3: still exactly 8 results after the zombie submitted (no duplicates, got ${(n3after.scorecard?.results ?? []).length})`,
  );
  const n3drain = await waitTerminal(
    (
      await post("/scorecards", {
        dataset: { id: "sh-echo-parallel", version: "1.0.0" },
        harness: { id: "sh-bench" },
        runtime: "self",
        concurrency: 4,
      })
    ).json.id,
    240,
  );
  check(n3drain.status === "succeeded", "N3: a fresh batch passes with the thawed runner back in the pool");
  check(
    cliProcs.every((p) => p.exitCode === null) && host.status().state !== "off",
    "fleet: every runner (including the thawed zombie) alive at the end",
  );

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — every engineered failure was fast, explicit, and classified; the fleet survived all of them."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  try {
    await host?.stop();
  } catch {}
  for (const p of cliProcs) {
    try {
      p.kill("SIGCONT");
    } catch {}
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  try {
    cp.kill("SIGKILL");
  } catch {}
  if (!process.env.KEEP) {
    for (const net of [NETWORK, "everdict-sse-relay-monster-1.0.0"]) {
      try {
        const names = sh("docker", ["ps", "-aq", "--filter", `name=${net}`]).trim();
        if (names) sh("docker", ["rm", "-f", ...names.split("\n")], { stdio: "ignore" });
        sh("docker", ["network", "rm", net], { stdio: "ignore" });
      } catch {}
    }
  }
}
process.exit(ok ? 0 : 1);
