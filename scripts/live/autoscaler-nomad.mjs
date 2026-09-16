// Live verification: queue-depth-based autoscaling elastically adjusts capacity on a real Nomad.
//
// NomadBackend reads maxConcurrent dynamically (a slot getter). Start slots=1. Submit N at once and
// the scheduler launches only 1, queuing the rest → the autoscaler sees the backlog and raises slots up to MAX,
// concurrent allocs grow, and when the queue drains it scales back down to MIN. A poller observes the actual concurrent alloc count.
//
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-job-runner:local node scripts/live/autoscaler-nomad.mjs

import { BackendRegistry, NomadBackend, Scheduler } from "../../packages/backends/dist/index.js";
import { Autoscaler, MutableSlots, aggregateLoad, caseOutcome } from "../../packages/domain/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-job-runner:local";
const N = Number(process.env.N ?? "8");
const MIN = Number(process.env.MIN ?? "1");
const MAX = Number(process.env.MAX ?? "4");
// A bounded wait, because an UNREACHABLE Nomad is silently the worst case here: `capacity()` answers
// used:"unknown", the Scheduler reads that as no free slot (it may not spend a reading nobody verified), and
// every dispatch stays queued forever. The script used to hang there rather than say so.
const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? "600000");
const STAMP = Date.now().toString(36);

function jobFor(i) {
  return {
    harness: { id: "scripted", version: "latest" },
    evalCase: {
      id: `as-${STAMP}-${i}`,
      env: { kind: "repo", source: { files: {} } },
      task: `autoscale case ${i}`,
      graders: [{ id: "steps" }],
      timeoutSec: 120,
      tags: ["live", "autoscale"],
    },
  };
}

// A poll that could not reach Nomad counted NOTHING — reporting that as 0 concurrent allocs is the reading
// that made a dead cluster look like an idle one. Third value, and the caller keeps score of it.
async function runningCount() {
  try {
    const r = await fetch(`${NOMAD_ADDR}/v1/jobs?prefix=everdict-as-${STAMP}&namespace=*`);
    if (!r.ok) return "unknown";
    const jobs = await r.json();
    return jobs.filter((j) => j.Status === "running" || j.Status === "pending").length;
  } catch {
    return "unknown";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const slots = new MutableSlots("nomad", MIN); // start=MIN, dynamic
  const backend = new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: slots.get });
  const sched = new Scheduler(new BackendRegistry().register("nomad", backend));

  // The backend's own reachability answer, before anything is queued — so "Nomad is not there" is named here
  // rather than served as an autoscaler that never scaled.
  const reach = await backend.probe();
  if (!reach.reachable) {
    console.error(`\nLIVE RUN FAILED: Nomad unreachable at ${NOMAD_ADDR} — ${reach.detail}`);
    process.exit(1);
  }
  console.log(`nomad @ ${NOMAD_ADDR}: ${reach.detail}`);

  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);
  const auto = new Autoscaler({
    signal: () => aggregateLoad(sched.stats()),
    targets: [slots],
    policy: { min: MIN, max: MAX, scaleDownAfterTicks: 3 },
    intervalMs: 600,
    onScale: (id, from, to) =>
      console.log(`  ↕ autoscale t+${el()}s  ${id}: ${from} → ${to} slots  (queued=${sched.stats().queued})`),
    onChanged: () => sched.poke(),
  });

  console.log(`submitting ${N} cases at once; slots start=${MIN}, autoscale range [${MIN}..${MAX}]\n`);
  let peak = 0;
  let blindPolls = 0;
  const poller = setInterval(async () => {
    const seen = await runningCount();
    if (seen === "unknown") blindPolls++;
    else peak = Math.max(peak, seen);
  }, 400);
  auto.start();

  // The deadline is the script's own; a queue that never drains ends the run with a named reason.
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const settled = await Promise.all(
    Array.from({ length: N }, (_, i) => jobFor(i)).map((job) =>
      sched.dispatch(job, { signal: deadline }).then(
        (result) => ({ ok: true, result }),
        (err) => ({
          ok: false,
          id: job.evalCase.id,
          code: err?.code ?? "THROWN",
          message: err?.message ?? String(err),
        }),
      ),
    ),
  );
  const done = settled.filter((s) => s.ok);

  // Observe scale-down after drain (run a few more ticks)
  console.log(`\nall ${done.length}/${N} done @ t+${el()}s — observing scale-down …`);
  for (let i = 0; i < 6 && slots.current() > MIN; i++) await sleep(700);

  auto.stop();
  clearInterval(poller);
  console.log("\n=== RESULT ===");
  console.log(`peak concurrent allocs on Nomad: ${peak} (autoscaled within [${MIN}..${MAX}])`);
  console.log(`final slots after drain        : ${slots.current()} (back toward MIN=${MIN})`);

  // Elasticity is a claim about capacity that CARRIED WORK — a peak observed while every case failed says
  // nothing, and that was the whole of the old ✅. So the dispatches are read first, through the domain's own
  // reading of a CaseResult, and only then the scale numbers.
  const problems = [];
  for (const s of settled) {
    if (!s.ok) {
      problems.push(`case ${s.id} never produced a result: ${s.code} — ${s.message}`);
      continue;
    }
    const outcome = caseOutcome(s.result);
    if (outcome.status === "infra_failed" || outcome.status === "cancelled")
      problems.push(
        `case ${s.result.caseId} ${outcome.status} at stage ${outcome.failure.stage}: ${outcome.failure.code} — ${outcome.failure.message}`,
      );
    // `steps` is observation-only, so this case has no pass/fail verdict to assert — what it must have is the
    // measurement it declared. No scores = a job that returned without measuring anything.
    else if (!s.result.scores.some((sc) => sc.metric === "tool_calls"))
      problems.push(`case ${s.result.caseId} produced no tool_calls score (scores: ${s.result.scores.length})`);
  }
  if (blindPolls > 0)
    problems.push(`${blindPolls} capacity polls could not reach Nomad — the peak above is not a count`);
  if (!(peak > MIN && peak <= MAX)) problems.push(`peak=${peak} did not scale up within (${MIN}..${MAX}]`);
  if (slots.current() !== MIN) problems.push(`slots settled at ${slots.current()}, not back down to MIN=${MIN}`);

  if (problems.length > 0) {
    console.log("\nLIVE RUN FAILED:");
    for (const p of problems) console.log("  -", p);
    process.exit(1);
  }
  console.log(
    "✅ elastic: scaled UP under backlog, scaled DOWN when idle, never exceeded MAX — on N cases that all ran",
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
