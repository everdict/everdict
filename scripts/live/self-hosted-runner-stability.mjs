// Live E2E: self-hosted runner STABILITY under cancel + failures + recovery.
//
// The user's worry: several runners handling many jobs at once, some jobs cancelled mid-flight, some jobs
// problematic — do the runners stay healthy, does the work actually stop on the machine, and can a user recover?
//
// This drives the REAL engine in-process (no HTTP hop — that's separately proven by scripts/live/multi-runner-pool.mjs
// + server.test.ts). Everything stability-critical is the real code:
//   RunnerHub (@everdict/application-control) · runLeaseWorkers/runLeasedJob (@everdict/self-hosted-runner) ·
//   runCase (@everdict/application-execution) · LocalDriver (@everdict/drivers) · CommandHarness (@everdict/harnesses) ·
//   ScorecardService.cancel/retryFailed + stopInFlight/cancelLeased (@everdict/application-control).
// The cases run host-native (LocalDriver) as `sh -c <task>`, so a cancel must actually SIGKILL the host `sleep`.
//
// Verifies:
//   A. 3 runners drain a pool of concurrent jobs.
//   B. Cancel a running scorecard mid-flight → status=cancelled, the in-flight host `sleep` processes are KILLED
//      (no zombie), and the runners survive → a fresh scorecard immediately completes on the same runners (stability).
//   C. A problematic (failing) case is isolated (verdict=fail); the user "fixes" it and retryFailed re-runs ONLY the
//      failures → they recover (all pass).
//
// Prereqs: pnpm build (the @everdict/* packages; this script imports their dist).
// Usage:   node scripts/live/self-hosted-runner-stability.mjs

import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { RunnerHub, ScorecardService, poolKeyFor } from "../../packages/application-control/dist/index.js";
import { InMemoryRunStore, InMemoryScorecardStore } from "../../packages/db/dist/index.js";
import { InMemoryDatasetRegistry } from "../../packages/registry/dist/index.js";
import { runLeaseWorkers, runLeasedJob } from "../../packages/self-hosted-runner/dist/index.js";

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TENANT = "acme";
const OWNER = `ws:${TENANT}`; // self:ws workspace pool owner
const FIX = `/tmp/evd-stability-${process.pid}-fixed`; // "the user fixed the problem" marker (host path)
const log = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n✗ FAIL — ${m}`);
  process.exit(1);
};

// ── the agent under test: a declarative command harness that runs the case task as a host shell command ──
const HARNESS = {
  kind: "command",
  id: "shell",
  version: "1.0.0",
  setup: [],
  command: "sh -c {{task}}", // {{task}} is shell-escaped by the harness — the case task IS the command
  env: {},
  trace: { kind: "none" },
};
// A case: task runs as `sh -c '<task>'` in cwd "work"; the tests-pass grader checks "work/pass.txt" (same cwd).
const evalCase = (id, task) => ({
  id,
  env: { kind: "repo", source: { files: {} } },
  task,
  graders: [{ id: "tests-pass", config: { cmd: "test -f pass.txt" } }],
  timeoutSec: 120,
  tags: ["stability"],
});

// Minimal harness registry (embed the command spec into the job so the runner runs the CommandHarness).
const harnesses = {
  get: async (_tenant, id, version) => ({ ...HARNESS, id, version: version === "latest" ? HARNESS.version : version }),
};

// ── count the leaf `sleep 7` processes our cases spawn (exact cmdline → excludes the `sh -c` wrapper).
// This is the real "work on the machine"; a cancel must SIGKILL every one (no zombie).
const sleepProcs = async () => {
  const { stdout } = await pexec("bash", ["-lc", "pgrep -fxc 'sleep 7' || true"]).catch(() => ({ stdout: "0" }));
  return Number.parseInt(stdout.trim() || "0", 10);
};
const sleepProcList = async () => {
  const { stdout } = await pexec("bash", ["-lc", "pgrep -fa 'sleep 7' || true"]).catch(() => ({ stdout: "" }));
  return stdout.trim();
};

// ── the RunnerHub (shared) + a per-runner MCP-shim that talks to it directly (the transport is not what we test) ──
const hub = new RunnerHub({ queueTimeoutMs: 60_000, leaseTtlMs: 15_000 });
const runnerCallJson = (key) => async (name, args) => {
  if (name === "lease_job") return (await hub.leaseWait(key, args.wait_ms ?? 0, args.capabilities)) ?? { job: null };
  if (name === "heartbeat_job") {
    const hb = args.jobId ? hub.heartbeat(key, args.jobId) : undefined;
    return { ok: true, ...(hb ? { extended: hb.extended, cancelled: hb.cancelled } : {}) };
  }
  if (name === "submit_job_result") return { jobId: args.jobId, accepted: hub.complete(key, args.jobId, args.result) };
  if (name === "fail_job") return { jobId: args.jobId, accepted: hub.fail(key, args.jobId, args.message) };
  return { ok: true };
};

// ── start N real runners (each its own runLeaseWorkers pool draining the shared self:ws pool) ──
let stop = false;
const runners = [];
const startRunner = (id, maxConcurrent) => {
  const key = { owner: OWNER, runnerId: id };
  const loop = runLeaseWorkers(
    {
      callJson: runnerCallJson(key),
      // The real leased-job path — host-native (no docker): CommandHarness → LocalDriver → `sh -c <task>` on THIS host.
      runJob: (job, opts) => runLeasedJob(job, { dockerAvailable: false, signal: opts?.signal }),
      log: () => {},
    },
    { maxConcurrent, waitMs: 400, heartbeatMs: 250, pollMs: 150, capabilities: ["repo"], shouldStop: () => stop },
  );
  runners.push({ id, loop });
};

// ── the control plane: the REAL ScorecardService, dispatching self:ws jobs into the hub ──
const store = new InMemoryScorecardStore();
const runStore = new InMemoryRunStore();
const datasets = new InMemoryDatasetRegistry();
const dispatcher = {
  // Route every case to the workspace self:ws pool (the batch injects runtime=self:ws as placement.target).
  async dispatch(job) {
    const { result, ranBy } = await hub.enqueue(poolKeyFor(OWNER), job);
    return { ...result, provenance: { ranOn: "self-hosted", runner: ranBy, by: OWNER } };
  },
};
const scorecards = new ScorecardService({
  dispatcher,
  store,
  runStore, // child runs per case (needed for stopInFlight + hydration)
  datasets,
  harnesses,
  concurrency: 4,
  // Self-hosted lease cancel — the force-free path this whole feature adds (managed killCase is not wired here).
  cancelLeased: (predicate) => hub.requestCancel(predicate),
});

const submitAndWaitRunning = async (datasetId) => {
  const rec = await scorecards.submit({
    tenant: TENANT,
    dataset: { id: datasetId, version: "latest" },
    harness: { id: "shell", version: "latest" },
    runtime: "self:ws",
  });
  for (let i = 0; i < 100; i++) {
    const r = await scorecards.get(rec.id);
    if (r.status === "running" || r.status === "succeeded" || r.status === "failed" || r.status === "cancelled")
      return rec.id;
    await sleep(50);
  }
  return rec.id;
};
const waitTerminal = async (id) => {
  for (let i = 0; i < 200; i++) {
    const r = await scorecards.get(id);
    if (["succeeded", "failed", "cancelled", "superseded"].includes(r.status)) return r;
    await sleep(100);
  }
  return scorecards.get(id);
};

try {
  // Register datasets. Cases run as `sh -c '<task>'`; a pass writes work/pass.txt.
  await datasets.register(TENANT, {
    id: "slow",
    version: "1.0.0",
    cases: Array.from({ length: 6 }, (_, i) => evalCase(`slow-${i}`, "sleep 7 && echo ok > pass.txt")),
  });
  await datasets.register(TENANT, {
    id: "fresh",
    version: "1.0.0",
    cases: Array.from({ length: 4 }, (_, i) => evalCase(`fresh-${i}`, "echo ok > pass.txt")),
  });
  await datasets.register(TENANT, {
    id: "mixed",
    version: "1.0.0",
    cases: [
      evalCase("ok-1", "echo ok > pass.txt"),
      evalCase("ok-2", "echo ok > pass.txt"),
      // Problematic cases: fail unless the user has "fixed" the problem (the FIX marker). Recoverable via retry.
      evalCase("bad-1", `test -f ${FIX} && echo ok > pass.txt || { sleep 1 ; exit 5 ; }`),
      evalCase("bad-2", `test -f ${FIX} && echo ok > pass.txt || { sleep 1 ; exit 5 ; }`),
    ],
  });

  startRunner("r1", 2);
  startRunner("r2", 2);
  startRunner("r3", 2);
  log("▶ started 3 self-hosted runners (self:ws pool, maxConcurrent=2 each = 6 slots)");
  await sleep(300);

  // ───────────────────────── A + B: many concurrent jobs, cancel mid-flight, prove the machine is freed ─────────────
  log("\n── Scenario A/B: 6 slow jobs across 3 runners, then STOP mid-flight ──");
  const id = await submitAndWaitRunning("slow");
  // Wait until the runners are actually executing (host `sleep 7` processes exist).
  let running = 0;
  for (let i = 0; i < 60; i++) {
    running = await sleepProcs();
    if (running >= 3) break;
    await sleep(100);
  }
  log(`  running: ${running} host 'sleep' processes in flight (runners busy)`);
  if (running < 3) fail(`expected ≥3 in-flight host processes, saw ${running} (runners not draining the pool)`);

  const beforeCancel = await scorecards.get(id);
  if (beforeCancel.status !== "running") fail(`batch not running before cancel (status=${beforeCancel.status})`);

  log("  → POST cancel (user hits Stop)…");
  const cancelled = await scorecards.cancel({ tenant: TENANT, id });
  if (cancelled.status !== "cancelled") fail(`cancel did not mark cancelled (status=${cancelled.status})`);
  if (cancelled.error?.code !== "CANCELLED") fail(`cancel error code wrong: ${JSON.stringify(cancelled.error)}`);
  log("  ✓ scorecard marked cancelled");

  // The heartbeat carries the cancel within ~250ms; the runner aborts runCase → LocalDriver.dispose SIGKILLs `sleep`.
  let leftover = running;
  for (let i = 0; i < 40; i++) {
    leftover = await sleepProcs();
    if (leftover === 0) break;
    await sleep(150);
  }
  if (leftover !== 0)
    fail(
      `${leftover} host 'sleep' process(es) still alive after cancel — the runtime was NOT freed\n  leftover: ${await sleepProcList()}`,
    );
  log("  ✓ all in-flight host processes were KILLED (runtime freed mid-case, no zombie)");

  const finalA = await waitTerminal(id);
  if (finalA.status !== "cancelled") fail(`batch settled ${finalA.status}, expected cancelled`);
  log("  ✓ batch settled terminal=cancelled");

  // Stability: the runners survived the cancel → a fresh scorecard runs to completion on the same runners.
  log("  → submit a FRESH scorecard (do the runners still work after a cancel?)…");
  const freshId = await submitAndWaitRunning("fresh");
  const fresh = await waitTerminal(freshId);
  if (fresh.status !== "succeeded") fail(`fresh scorecard after cancel is ${fresh.status}, expected succeeded`);
  const freshRunners = new Set((await runStore.list(TENANT, { scorecardId: freshId })).map((c) => c.runtime));
  log(`  ✓ STABILITY — fresh scorecard succeeded on the surviving runners (${fresh.summary?.[0]?.count ?? "?"} cases)`);

  // ───────────────────────── C: a problematic job, and user recovery via retry-failed ─────────────
  log("\n── Scenario C: mixed batch (2 ok + 2 problematic), then user fixes + retry-failed recovers ──");
  const mixId = await submitAndWaitRunning("mixed");
  const mixed = await waitTerminal(mixId);
  const results = mixed.scorecard?.results ?? [];
  const verdictOf = (cid) =>
    results.find((r) => r.caseId === cid)?.scores?.find((s) => s.metric === "tests_pass")?.pass;
  const passed = results.filter((r) => r.scores?.some((s) => s.metric === "tests_pass" && s.pass === true)).length;
  const failed = results.filter((r) => r.scores?.some((s) => s.metric === "tests_pass" && s.pass === false)).length;
  log(`  batch finished status=${mixed.status}: ${passed} passed, ${failed} failed (of ${results.length})`);
  if (verdictOf("bad-1") !== false || verdictOf("bad-2") !== false)
    fail(`problematic cases did not fail as expected: bad-1=${verdictOf("bad-1")} bad-2=${verdictOf("bad-2")}`);
  if (verdictOf("ok-1") !== true || verdictOf("ok-2") !== true) fail("healthy cases did not pass (isolation broken)");
  log("  ✓ problematic cases isolated as failures; healthy cases unaffected (batch resilience)");

  log("  → user fixes the problem, then clicks Retry failed…");
  await pexec("touch", [FIX]); // "the user fixed it"
  const retried = await scorecards.retryFailed({ tenant: TENANT, id: mixId });
  const recovered = await waitTerminal(retried.id);
  const rResults = recovered.scorecard?.results ?? [];
  const rVerdict = (cid) =>
    rResults.find((r) => r.caseId === cid)?.scores?.find((s) => s.metric === "tests_pass")?.pass;
  // retry-failed re-runs ONLY the failures and carries the passing cases over → all 4 should now pass.
  const allPass = ["ok-1", "ok-2", "bad-1", "bad-2"].every((c) => rVerdict(c) === true);
  if (recovered.status !== "succeeded" || !allPass)
    fail(`recovery failed: status=${recovered.status}, verdicts=${JSON.stringify(["bad-1", "bad-2"].map(rVerdict))}`);
  log(`  ✓ RECOVERY — retry-failed re-ran the ${failed} failure(s), all ${rResults.length} cases now pass`);

  log(
    "\n✅ PASS — self-hosted runners are stable under cancel + failures: work is force-stopped on the machine, and users recover via re-run / retry-failed.",
  );
} catch (e) {
  fail(e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  stop = true;
  await Promise.race([Promise.all(runners.map((r) => r.loop.catch(() => {}))), sleep(2000)]);
  await pexec("rm", ["-f", FIX]).catch(() => {});
}
process.exit(0);
