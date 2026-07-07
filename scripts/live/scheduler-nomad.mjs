// Live verification: the capacity-aware Scheduler "fluidly distributes" work across a real Nomad cluster.
//
// N cases are submitted at once, but because of NomadBackend's maxConcurrent=CAP the
// scheduler brings up only CAP allocs at a time and queues the rest. As slots free up, it lets the next ones through.
// A separate poller observes the number of in-flight everdict-sched-* jobs on Nomad to prove concurrent allocs never exceed CAP.
//
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-agent:local node scripts/live/scheduler-nomad.mjs

import { BackendRegistry, NomadBackend, Scheduler } from "../../packages/backends/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-agent:local";
const N = Number(process.env.N ?? "5");
const CAP = Number(process.env.CAP ?? "2");
const STAMP = Date.now().toString(36);

function jobFor(i) {
  return {
    harness: { id: "scripted", version: "latest" },
    evalCase: {
      id: `sched-${STAMP}-${i}`,
      env: { kind: "repo", source: { files: {} } },
      task: `scheduler distribution case ${i}`,
      graders: [{ id: "steps" }, { id: "cost" }, { id: "latency" }],
      timeoutSec: 120,
      tags: ["live", "scheduler"],
    },
  };
}

async function runningCount() {
  try {
    const r = await fetch(`${NOMAD_ADDR}/v1/jobs?prefix=everdict-sched-${STAMP}`);
    const jobs = await r.json();
    return jobs.filter((j) => j.Status === "running" || j.Status === "pending").length;
  } catch {
    return 0;
  }
}

async function main() {
  const registry = new BackendRegistry().register(
    "nomad",
    new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: CAP }),
  );
  const sched = new Scheduler(registry); // leastLoaded by default

  console.log(`submitting ${N} cases at once; backend cap = ${CAP}/concurrent\n`);
  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);

  let maxRunningAllocs = 0;
  const poller = setInterval(async () => {
    maxRunningAllocs = Math.max(maxRunningAllocs, await runningCount());
  }, 1000);
  const ticker = setInterval(() => {
    const s = sched.stats();
    console.log(
      `  t+${el()}s  queued=${s.queued}  inFlight=${JSON.stringify(s.inFlight)}  maxRunningAllocs=${maxRunningAllocs}`,
    );
  }, 3000);

  const tasks = Array.from({ length: N }, (_, i) =>
    sched
      .dispatch(jobFor(i))
      .then((r) => {
        console.log(
          `  ✓ case ${i} done @ t+${el()}s  scores=${r.scores.map((s) => `${s.graderId}:${s.value}`).join(",")}`,
        );
        return { i, ok: true };
      })
      .catch((e) => {
        console.log(`  ✗ case ${i} failed @ t+${el()}s  ${e.message}`);
        return { i, ok: false };
      }),
  );

  const results = await Promise.all(tasks);
  clearInterval(poller);
  clearInterval(ticker);

  const ok = results.filter((r) => r.ok).length;
  console.log("\n=== RESULT ===");
  console.log(`completed   : ${ok}/${N}`);
  console.log(`elapsed     : ${el()}s`);
  console.log(`peak concurrent allocs observed on Nomad: ${maxRunningAllocs} (cap=${CAP})`);
  console.log(maxRunningAllocs <= CAP ? "✅ capacity respected — never exceeded the cap" : "❌ cap exceeded!");
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
