// Live orchestration torture: **the batch-orchestration axes under deliberate overload**, one phase per
// axis, each with its own recovery/correctness assertion (companion to chaos-orchestration.mjs, which
// covers boot-resume/spillover on managed shards):
//
//   O3 subset        — cases.ids under load returns exactly the subset;
//   O2 trials        — trials=3 fans out per-case repetitions, all pass, trial indices complete;
//   O1 priority      — 3 INTERACTIVE single runs submitted into a ~100-case batch backlog finish fast
//                      (WFQ: a person is waiting) instead of queueing behind the flood;
//   O4 cancel storm  — 5 of 10 in-flight batches cancelled: they terminate as cancelled, their queued
//                      work is reclaimed, the surviving 5 complete 8/8, the fleet stays healthy;
//   O7 runtime shard — runtime:"self,<nomad>" splits ONE batch across the self-hosted pool AND a real
//                      Nomad runtime (agent image) — both lanes execute and every case passes
//                      (skipped unless Nomad answers at NOMAD_ADDR);
//   O5 backpressure  — a flood beyond EVERDICT_RUNNER_MAX_QUEUE fails the overflow FAST with the
//                      explicit queue-full error (never a silent pile-up), every batch reaches a
//                      terminal state, and the system drains back to healthy (a fresh batch passes).
//                      Submitted with retries:0 — with the default retry budget a small overflow is
//                      wholly ABSORBED (shed → 1s backoff → re-admitted as the queue drains), which is
//                      the designed shed+retry cooperation, but hides the shedding this phase asserts;
//   O6 rerun lineage — a finished batch reruns as a NEW record carrying origin.retryOf, and passes.
//
// Usage: node scripts/live/orchestration-torture.mjs   (docker + api/cli/self-hosted-runner dists built;
//   Nomad at NOMAD_ADDR [default http://127.0.0.1:4646] + everdict-agent:slim enable O7). ~15-20 min.
//   ⚠ O7 on a dev Nomad: the docker driver's image GC DELETES locally-built images after allocs die —
//   run `nomad agent -dev -config <hcl with plugin "docker" { config { gc { image = false } } }>` or
//   the agent image silently vanishes between runs (pull access denied → spillover hides the lane).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PORT = process.env.CP_PORT ?? "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const NETWORK = "everdict-sse-relay-bench-1.0.0";
const NOMAD = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const MAX_QUEUE = 200; // EVERDICT_RUNNER_MAX_QUEUE — high enough for O1/O4, exceeded on purpose by O5
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

const TOPO = {
  dataset: { id: "sse-relay-parallel", version: "1.0.0" },
  harness: { id: "sse-relay-bench" },
  runtime: "self",
};
const CMD = { dataset: { id: "sh-echo-parallel", version: "1.0.0" }, harness: { id: "sh-bench" }, runtime: "self" };
const submit = async (body, label = "submit") => {
  const r = await post("/scorecards", body);
  if (!r.json.id) throw new Error(`${label} failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.id;
};
const waitTerminal = async (id, minutes, opts = {}) => {
  let rec;
  for (let i = 0; i < (minutes * 60) / 2; i++) {
    await sleep(2000);
    rec = await get(`/scorecards/${id}`);
    if (rec.status === "succeeded" || rec.status === "failed" || rec.status === "cancelled") return rec;
    if (opts.quiet !== true)
      process.stdout.write(
        `  ${id.slice(0, 8)} status=${rec.status} settled=${rec.scorecard?.results?.length ?? 0}  \r`,
      );
  }
  return rec;
};
const passCount = (rec, metric) =>
  (rec.scorecard?.results ?? []).filter((r) =>
    (r.scores ?? []).some((s) => (metric ? s.metric === metric : s.graderId === "answer-match") && s.pass),
  ).length;

console.log("=== ⓪ images + clean slate ===");
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
let nomadUp = false;
try {
  nomadUp = (await fetch(`${NOMAD}/v1/status/leader`)).ok;
} catch {}
if (nomadUp && !sh("docker", ["images", "-q", process.env.AGENT_IMAGE ?? "everdict-agent:slim"]).trim()) {
  // A dev Nomad's docker image GC deletes locally-built images after allocs die (see the header) — an
  // absent agent image would make every O7 nomad case fail-pull and spill over to self, silently
  // voiding the phase. Skip loudly instead.
  console.log(
    "  ⚠ agent image missing locally (nomad image GC?) — O7 skipped; rebuild it and disable the driver's image GC",
  );
  nomadUp = false;
}
console.log(`  nomad at ${NOMAD}: ${nomadUp ? "UP (O7 enabled)" : "down/unusable (O7 skipped)"}`);

console.log(`\n=== ① control plane (:${PORT}, EVERDICT_RUNNER_MAX_QUEUE=${MAX_QUEUE}) + fleet (10 slots) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    EVERDICT_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: "",
    EVERDICT_RUNNER_MAX_QUEUE: String(MAX_QUEUE),
    NOMAD_ADDR: NOMAD,
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
  const spawnCli = (i, token, extra = []) => {
    const proc = spawn(
      "node",
      [
        "apps/cli/dist/main.js",
        "runner",
        "--pair",
        token,
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
    proc.stderr.on("data", (d) => process.stderr.write(`  [cli${i}] ${d}`));
    cliProcs.push(proc);
  };
  for (let i = 0; i < 2; i++) spawnCli(i, (await pair(`torture-cli-${i}`)).token);
  spawnCli(2, (await pair("torture-cli-wide")).token, ["--max-concurrent", "4"]);
  const shr = await import(pathToFileURL(`${ROOT}packages/self-hosted-runner/dist/index.js`).href);
  host = new shr.RunnerHost({
    apiUrl: BASE,
    token: (await pair("torture-desktop")).token,
    maxConcurrent: 4,
    log: (m) => process.stderr.write(`  [desktop] ${m}\n`),
  });
  await host.start();
  await sleep(3000);
  for (const file of ["bundle.json", "stress-bundle.json"]) {
    const applied = await post("/bundles/apply", JSON.parse(readFileSync(`${BUNDLE_DIR}/${file}`, "utf8")));
    if ((applied.json.results ?? []).some((r) => r.status === "failed")) throw new Error(`${file} apply failed`);
  }
  if (nomadUp) {
    const r = await post("/runtimes", {
      kind: "nomad",
      id: "nomad-t",
      version: "1.0.0",
      addr: NOMAD,
      image: process.env.AGENT_IMAGE ?? "everdict-agent:slim",
    });
    check(r.status < 300, `nomad runtime registered for O7 (${r.status})`);
  }
  const warm = await waitTerminal(await submit({ ...TOPO, cases: { limit: 1 } }, "warmup"), 8);
  check(warm.status === "succeeded", "warmup succeeded (topology deployed)");

  // ── O3 subset ───────────────────────────────────────────────────────────────
  console.log("\n=== O3 subset — cases.ids returns exactly the subset ===");
  const o3 = await waitTerminal(
    await submit({ ...TOPO, cases: { ids: ["parallel-2", "parallel-5"] }, concurrency: 4 }, "O3"),
    8,
  );
  check(o3.status === "succeeded", "O3: subset batch succeeded");
  const o3Ids = (o3.scorecard?.results ?? []).map((r) => r.caseId).sort();
  check(
    JSON.stringify(o3Ids) === JSON.stringify(["parallel-2", "parallel-5"]),
    `O3: exactly the 2 selected cases (${o3Ids})`,
  );

  // ── O2 trials ───────────────────────────────────────────────────────────────
  console.log("\n=== O2 trials — trials=3 fans out per-case repetitions ===");
  const o2 = await waitTerminal(await submit({ ...TOPO, cases: { limit: 4 }, trials: 3, concurrency: 8 }, "O2"), 10);
  check(o2.status === "succeeded", "O2: trials batch succeeded");
  const o2Results = o2.scorecard?.results ?? [];
  check(o2Results.length === 12, `O2: 4 cases × 3 trials = 12 results (got ${o2Results.length})`);
  check(passCount(o2) === 12, `O2: all 12 trial runs pass (got ${passCount(o2)})`);
  const trialsPerCase = new Map();
  for (const r of o2Results) trialsPerCase.set(r.caseId, new Set([...(trialsPerCase.get(r.caseId) ?? []), r.trial]));
  check(
    [...trialsPerCase.values()].every((s) => s.size === 3),
    "O2: every case carries a complete trial index set {0,1,2}",
  );

  // ── O1 priority ─────────────────────────────────────────────────────────────
  console.log("\n=== O1 priority — interactive runs jump a ~100-case batch backlog ===");
  const floodIds = [];
  for (let i = 0; i < 12; i++) floodIds.push(await submit({ ...TOPO, concurrency: 8 }, `O1 flood ${i}`));
  await sleep(4000); // the backlog is parked
  const latencies = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const run = await post("/runs", {
      harness: { id: "sse-relay-bench", version: "1.0.0" },
      case: {
        id: `interactive-${i}`,
        env: { kind: "prompt" },
        task: `priority probe ${i}`,
        expected: "ok=true",
        graders: [{ id: "answer-match" }],
        timeoutSec: 300,
        tags: ["interactive"],
        placement: { target: "self" },
      },
    });
    if (!run.json.id) throw new Error(`interactive submit failed: ${JSON.stringify(run.json)}`);
    let rec;
    for (let t = 0; t < 90; t++) {
      await sleep(2000);
      rec = await get(`/runs/${run.json.id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    const sec = (Date.now() - t0) / 1000;
    latencies.push(sec);
    check(rec.status === "succeeded", `O1: interactive run ${i} succeeded in ${sec.toFixed(1)}s`);
  }
  // With ~96 batch cases queued on 10 slots (~2+ min FIFO drain), a fair-queued interactive run must not
  // wait for the whole backlog. 90s = several case-lengths of slack while still proving the jump.
  check(
    latencies.every((s) => s < 90),
    `O1: every interactive run beat the backlog (latencies ${latencies.map((s) => s.toFixed(0)).join("/")}s)`,
  );
  const floodRecs = [];
  for (const id of floodIds) floodRecs.push(await waitTerminal(id, 15, { quiet: true }));
  check(
    floodRecs.every((r) => r.status === "succeeded"),
    "O1: the flood batches all still completed",
  );

  // ── O4 cancel storm ─────────────────────────────────────────────────────────
  console.log("\n=== O4 cancel storm — 5 of 10 in-flight batches cancelled ===");
  const o4Ids = [];
  for (let i = 0; i < 10; i++) o4Ids.push(await submit({ ...TOPO, concurrency: 4 }, `O4 ${i}`));
  await sleep(5000); // some leased, most parked
  const cancelled = o4Ids.filter((_, i) => i % 2 === 0);
  for (const id of cancelled) {
    const r = await post(`/scorecards/${id}/cancel`, {});
    check(r.status < 300, `O4: cancel accepted for ${id.slice(0, 8)}`);
  }
  const o4Recs = new Map();
  for (const id of o4Ids) o4Recs.set(id, await waitTerminal(id, 15, { quiet: true }));
  check(
    cancelled.every((id) => o4Recs.get(id).status === "cancelled"),
    `O4: cancelled batches terminal as cancelled (${cancelled.map((id) => o4Recs.get(id).status).join(",")})`,
  );
  const kept = o4Ids.filter((_, i) => i % 2 === 1);
  check(
    kept.every((id) => o4Recs.get(id).status === "succeeded" && passCount(o4Recs.get(id)) === 8),
    "O4: the surviving batches completed 8/8 through the storm",
  );

  // ── O7 runtime shard (self + nomad) ────────────────────────────────────────
  if (nomadUp) {
    console.log("\n=== O7 runtime shard — ONE batch split across self-hosted AND Nomad ===");
    const o7 = await waitTerminal(await submit({ ...CMD, runtime: "self,nomad-t", concurrency: 8 }, "O7"), 12);
    check(o7.status === "succeeded", "O7: sharded batch succeeded");
    const o7Results = o7.scorecard?.results ?? [];
    check(o7Results.length === 8, `O7: 8 results (got ${o7Results.length})`);
    check(passCount(o7, "tests_pass") === 8, "O7: all 8 pass on both lanes");
    const selfCases = o7Results.filter((r) => r.provenance?.ranOn === "self-hosted").length;
    check(
      selfCases >= 3 && selfCases <= 5,
      `O7: the batch really split — ${selfCases} self-hosted / ${8 - selfCases} nomad`,
    );
    // Forensics on a bad split: spillover/speculation steps carry the reason (e.g. the nomad lane failing
    // its dispatch and healing onto self would show "runtime spillover nomad-t → self (<code>)").
    if (selfCases !== 4)
      for (const s of (o7.steps ?? []).filter((x) => /spillover|speculation|FAIL/.test(x.message)))
        console.log(`    step: ${s.message.slice(0, 160)}`);
  } else {
    console.log("\n=== O7 skipped (nomad down) ===");
  }

  // ── O5 backpressure ────────────────────────────────────────────────────────
  console.log(`\n=== O5 backpressure — flood past EVERDICT_RUNNER_MAX_QUEUE=${MAX_QUEUE} ===`);
  // retries:0 — surface the shedding itself (the default retry budget would absorb this overflow).
  // Submit ALL batches CONCURRENTLY: command cases drain at 100+/s on 10 slots, so serially-awaited
  // submissions (~10-20 batches/s) produce slower than the fleet drains and the queue never crosses the
  // cap — the flood must land as one burst for the backpressure boundary to be reached deterministically.
  const O5_BATCHES = Number(process.env.O5_BATCHES ?? 100);
  const o5Ids = await Promise.all(
    Array.from({ length: O5_BATCHES }, (_, i) => submit({ ...CMD, concurrency: 8, retries: 0 }, `O5 ${i}`)),
  );
  const o5Recs = [];
  for (const id of o5Ids) o5Recs.push(await waitTerminal(id, 15, { quiet: true }));
  check(
    o5Recs.every((r) => r.status === "succeeded" || r.status === "failed"),
    "O5: every flood batch reached a terminal state (no wedge)",
  );
  const queueFullFailures = o5Recs
    .flatMap((r) => r.scorecard?.results ?? [])
    .filter((r) => (r.scores ?? []).some((s) => String(s.detail ?? "").includes("queue is full")));
  check(
    queueFullFailures.length > 0,
    `O5: overflow failed FAST with the explicit queue-full error (${queueFullFailures.length} cases)`,
  );
  const o5Passed = o5Recs
    .flatMap((r) => r.scorecard?.results ?? [])
    .filter((r) => (r.scores ?? []).some((s) => s.pass));
  console.log(
    `  O5: ${o5Passed.length} cases passed / ${queueFullFailures.length} shed by backpressure (of ${O5_BATCHES * 8})`,
  );
  const postFlood = await waitTerminal(await submit({ ...CMD, concurrency: 4 }, "O5 drain probe"), 8);
  check(
    postFlood.status === "succeeded" && passCount(postFlood, "tests_pass") === 8,
    "O5: the system drained back to healthy (fresh batch 8/8)",
  );

  // ── O6 rerun lineage ────────────────────────────────────────────────────────
  console.log("\n=== O6 rerun — a finished batch reruns as a new record with origin.retryOf ===");
  const rerun = await post(`/scorecards/${o3.id}/rerun`, {});
  check(rerun.status === 202 && rerun.json.id, `O6: rerun accepted (${rerun.status})`);
  const o6 = await waitTerminal(rerun.json.id, 10, { quiet: true });
  check(o6.status === "succeeded", "O6: rerun batch succeeded");
  check(
    o6.origin?.retryOf === o3.id,
    `O6: lineage recorded (origin.retryOf=${String(o6.origin?.retryOf).slice(0, 8)})`,
  );
  check((o6.scorecard?.results ?? []).length === 2, "O6: the rerun reproduced the source subset (2 cases)");

  // fleet health after the whole campaign
  check(
    cliProcs.every((p) => p.exitCode === null),
    "fleet: all CLI runner processes alive after the torture",
  );
  check(host.status().state !== "off", `fleet: RunnerHost alive (${host.status().state})`);

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — orchestration held under torture: priority, trials, subsets, cancel storm, backpressure shedding, rerun lineage, and a self+nomad shard all behaved."
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
