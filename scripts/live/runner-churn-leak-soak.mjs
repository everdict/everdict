// In-process leak soak (deterministic, gc-instrumented): drive the REAL RunnerHub + Scheduler through a large
// number of mixed-lifecycle rounds under heavy runner/batch churn, forcing GC at checkpoints and asserting the
// bookkeeping maps AND the JS heap stay BOUNDED (return to baseline) rather than climbing monotonically.
//
// Each round churns a FRESH runner id and a FRESH batch group and exercises every lifecycle exit:
//   · normal: enqueue → lease → complete
//   · dead runner: enqueue → lease → (no heartbeat) → idle-timeout reject
//   · cancel/supersede: enqueue → requestCancel
//   · pool + requeue: enqueue to the pool, lease from a runner, let the lease TTL requeue, another runner takes it
//
// PASS = after N rounds the RunnerHub.bookkeepingSize() is ~0 and heapUsed (post-gc) has not grown beyond a small
// slack over the warmed baseline. A leak (pre-fix) shows bookkeeping == N and heapUsed climbing linearly.
//
// Usage: node --expose-gc scripts/live/runner-churn-leak-soak.mjs [rounds=20000]
import process from "node:process";
import { pathToFileURL } from "node:url";

if (typeof global.gc !== "function") {
  console.error("run with --expose-gc:  node --expose-gc scripts/live/runner-churn-leak-soak.mjs");
  process.exit(2);
}
const ROOT = new URL("../..", import.meta.url).pathname;
const { RunnerHub, poolKeyFor } = await import(pathToFileURL(`${ROOT}packages/application-control/dist/index.js`).href);
const ROUNDS = Number(process.argv[2] ?? 20000);

const result = {
  caseId: "c",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const job = (id, batchId) => ({
  evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
  batchId,
});

// A short lease TTL + idle timeout so the dead-runner and requeue paths settle fast in the soak.
const hub = new RunnerHub({ leaseTtlMs: 5, queueTimeoutMs: 12 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const heapMb = () => {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

let baseline = 0;
const samples = [];
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

console.log(`=== in-process churn leak soak — ${ROUNDS} mixed-lifecycle rounds ===`);
for (let r = 0; r < ROUNDS; r++) {
  const owner = "u-alice";
  const runner = { owner, runnerId: `runner-${r}` }; // fresh runner id (churn)
  const runner2 = { owner, runnerId: `runner2-${r}` };
  const batch = `batch-${r}`;
  const mode = r % 4;

  if (mode === 0) {
    // normal: enqueue 3 → lease+complete each
    const ds = [0, 1, 2].map((c) => {
      const d = hub.enqueue(runner, job(`c${c}`, batch));
      d.catch(() => {});
      return d;
    });
    for (let c = 0; c < 3; c++) {
      const l = hub.lease(runner, ["git"]);
      if (l) hub.complete(runner, l.jobId, result);
    }
    await Promise.all(ds);
  } else if (mode === 1) {
    // dead runner: lease then let the idle timeout reject it (no heartbeat). The hub's timers are unref'd, so a
    // ref'd sleep past queueTimeoutMs keeps the loop alive for the reject to fire before we await it.
    const d = hub.enqueue(runner, job("c0", batch));
    d.catch(() => {});
    hub.lease(runner, ["git"]);
    await sleep(16); // > queueTimeoutMs (12) → the idle-timeout reject has fired
    await d.catch(() => {}); // rejected as no_runner
  } else if (mode === 2) {
    // cancel/supersede: enqueue then requestCancel
    const d = hub.enqueue(runner, job("c0", batch));
    d.catch(() => {});
    hub.requestCancel((j) => j.batchId === batch);
    await d.catch(() => {});
    // the cancelled entry lingers until the runner's submit or idle timeout — drain it
    await sleep(15);
    hub.lease(runner, ["git"]); // clears requeued/expired
  } else {
    // pool + requeue: enqueue to the pool, one runner leases, lease TTL requeues, another runner completes
    const d = hub.enqueue(poolKeyFor(owner), job("c0", batch));
    d.catch(() => {});
    hub.lease(runner, ["git"]); // leases from the pool
    await sleep(8); // > leaseTtlMs → requeuable
    const l = hub.lease(runner2, ["git"]); // another runner re-acquires
    if (l) hub.complete(runner2, l.jobId, result);
    await d.catch(() => {});
  }

  if (r === Math.floor(ROUNDS * 0.05)) baseline = heapMb(); // warm baseline after 5%
  if (r > 0 && r % Math.floor(ROUNDS / 10) === 0) {
    const bk = hub.bookkeepingSize();
    const heap = heapMb();
    samples.push({ r, heap, bk });
    console.log(`  round ${String(r).padStart(6)} · heapUsed=${heap.toFixed(1)}MB · bookkeeping=${JSON.stringify(bk)}`);
  }
}

// settle any lingering timers, then final measurement
await sleep(30);
const finalBk = hub.bookkeepingSize();
const finalHeap = heapMb();
console.log(`\n=== verdict (${ROUNDS} rounds) ===`);
console.log(
  `  baseline heap=${baseline.toFixed(1)}MB · final heap=${finalHeap.toFixed(1)}MB · final bookkeeping=${JSON.stringify(finalBk)}`,
);
check(
  finalBk.queues <= 2 && finalBk.groups === 0 && finalBk.waiters === 0,
  `bookkeeping bounded (${JSON.stringify(finalBk)})`,
);
// Heap: after the warmed baseline, N more churned rounds must not grow the retained heap beyond a small slack.
// A per-round leak of even ~200 bytes over 20k rounds would be ~4MB+ of monotonic climb; bound at 8MB is generous
// (GC noise) yet catches a real leak.
const growth = finalHeap - baseline;
check(
  growth < 8,
  `retained heap did not climb with churn (Δ=${growth.toFixed(1)}MB over ${ROUNDS} rounds after baseline)`,
);
// Monotonicity: the last checkpoint heap must not exceed the median checkpoint heap by a large margin.
const heaps = samples.map((s) => s.heap).sort((a, b) => a - b);
const median = heaps[Math.floor(heaps.length / 2)] ?? finalHeap;
check(finalHeap < median + 8, `no monotonic climb (final ${finalHeap.toFixed(1)}MB vs median ${median.toFixed(1)}MB)`);

const ok = failures.length === 0;
console.log(
  ok
    ? "\n✅ PASS — the lease hub's bookkeeping and the JS heap stay bounded under heavy mixed-lifecycle churn."
    : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
);
process.exit(ok ? 0 : 1);
