// Live verification: tenant fair scheduling (WFQ) works on real Nomad.
//
// Tenant A submits 4 first, tenant B submits 1 later. Backend cap=1 (one at a time).
//  - Under FIFO, B runs only last (5th).
//  - Under WFQ, B jumps in right after one A (2nd) → one tenant's bulk submit does not starve another.
// Prove it by recording the dispatch order with a wrapper backend.
//
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-job-runner:local node scripts/live/fair-scheduler-nomad.mjs

import { BackendRegistry, NomadBackend, Scheduler } from "../../packages/backends/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-job-runner:local";
const STAMP = Date.now().toString(36);

// Wrapper that records the order of dispatched case ids.
class LoggingBackend {
  id = "nomad";
  order = [];
  constructor(inner) {
    this.inner = inner;
  }
  capacity() {
    return this.inner.capacity();
  }
  dispatch(job) {
    this.order.push(job.evalCase.id);
    return this.inner.dispatch(job);
  }
}

function jobFor(tenant, label) {
  return {
    harness: { id: "scripted", version: "latest" },
    tenant,
    evalCase: {
      id: `${STAMP}-${label}`,
      env: { kind: "repo", source: { files: {} } },
      task: `fair sched ${label}`,
      graders: [{ id: "steps" }],
      timeoutSec: 120,
      tags: ["live", "fair"],
    },
  };
}

async function main() {
  const backend = new LoggingBackend(new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: 1 }));
  const sched = new Scheduler(new BackendRegistry().register("nomad", backend)); // equal weight, WFQ

  // A's 4 first, B's 1 later — all submitted at once.
  const submit = [
    jobFor("tenant-A", "A0"),
    jobFor("tenant-A", "A1"),
    jobFor("tenant-A", "A2"),
    jobFor("tenant-A", "A3"),
    jobFor("tenant-B", "B0"),
  ];
  console.log("submitted: A0,A1,A2,A3 (tenant-A), then B0 (tenant-B); backend cap=1\n");

  const t0 = Date.now();
  const results = await Promise.all(
    submit.map((j) => sched.dispatch(j).then(() => j.evalCase.id.replace(`${STAMP}-`, ""))),
  );

  const order = backend.order.map((id) => id.replace(`${STAMP}-`, ""));
  const bIndex = order.indexOf("B0");
  console.log("=== RESULT ===");
  console.log("dispatch order :", order.join(" → "));
  console.log("completed      :", results.length, `cases in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`tenant-B served at position: ${bIndex + 1} of ${order.length}`);
  console.log(
    bIndex === 1
      ? "✅ WFQ fairness — B jumped ahead of A's backlog (FIFO would put B last)"
      : `⚠ B at position ${bIndex + 1} (expected 2)`,
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
