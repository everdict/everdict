// Live verification: queue-depth-based autoscaling elastically adjusts capacity on a real Nomad.
//
// NomadBackend reads maxConcurrent dynamically (a slot getter). Start slots=1. Submit N at once and
// the scheduler launches only 1, queuing the rest → the autoscaler sees the backlog and raises slots up to MAX,
// concurrent allocs grow, and when the queue drains it scales back down to MIN. A poller observes the actual concurrent alloc count.
//
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-agent:local node scripts/live/autoscaler-nomad.mjs

import {
  Autoscaler,
  BackendRegistry,
  MutableSlots,
  NomadBackend,
  Scheduler,
  aggregateLoad,
} from "../../packages/backends/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-agent:local";
const N = Number(process.env.N ?? "8");
const MIN = Number(process.env.MIN ?? "1");
const MAX = Number(process.env.MAX ?? "4");
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

async function runningCount() {
  try {
    const r = await fetch(`${NOMAD_ADDR}/v1/jobs?prefix=everdict-as-${STAMP}&namespace=*`);
    const jobs = await r.json();
    return jobs.filter((j) => j.Status === "running" || j.Status === "pending").length;
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const slots = new MutableSlots("nomad", MIN); // start=MIN, dynamic
  const backend = new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: slots.get });
  const sched = new Scheduler(new BackendRegistry().register("nomad", backend));

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
  const poller = setInterval(async () => {
    peak = Math.max(peak, await runningCount());
  }, 400);
  auto.start();

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      sched
        .dispatch(jobFor(i))
        .then(() => true)
        .catch(() => false),
    ),
  );

  // Observe scale-down after drain (run a few more ticks)
  console.log(`\nall ${results.filter(Boolean).length}/${N} done @ t+${el()}s — observing scale-down …`);
  for (let i = 0; i < 6 && slots.current() > MIN; i++) await sleep(700);

  auto.stop();
  clearInterval(poller);
  console.log("\n=== RESULT ===");
  console.log(`peak concurrent allocs on Nomad: ${peak} (autoscaled within [${MIN}..${MAX}])`);
  console.log(`final slots after drain        : ${slots.current()} (back toward MIN=${MIN})`);
  console.log(
    peak > MIN && peak <= MAX && slots.current() === MIN
      ? "✅ elastic: scaled UP under backlog, scaled DOWN when idle, never exceeded MAX"
      : `ℹ peak=${peak}, final=${slots.current()}`,
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
