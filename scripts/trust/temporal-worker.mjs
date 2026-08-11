#!/usr/bin/env node
// A REAL Temporal worker running THIS repository's workflow module (docs/trust-certification.md — TRUST-140).
//
// The activities are the scenario's, not production's: what is under test is the workflow code's replay
// behaviour and the durability of the execution, so the activity's only job is to be observable and slow
// enough to be killed in the middle of. It records every invocation in Postgres — the ledger the scenario
// reads to tell "the replacement worker re-ran the activity" from "the workflow silently lost it".
//
// The workflow module is the BUILT one (`packages/orchestrator/dist/workflows.js`), because a scenario that
// bundled the TypeScript would be certifying a different program than an operator runs.
import { createRequire } from "node:module";
import process from "node:process";

// pnpm does not hoist, so both dependencies are resolved from the packages that declare them — the same
// borrow the other live scripts make for `pg`.
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const pg = require("pg");
const fromOrchestrator = createRequire(new URL("../../packages/orchestrator/package.json", import.meta.url));
const { NativeConnection, Worker } = await import(
  new URL(fromOrchestrator.resolve("@temporalio/worker"), "file:").href
);

const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const taskQueue = process.env.TRUST_TASK_QUEUE;
const holdMs = Number(process.env.TRUST_ACTIVITY_HOLD_MS ?? "0");
if (!taskQueue || !process.env.DATABASE_URL) {
  console.error("usage: TRUST_TASK_QUEUE=… DATABASE_URL=… temporal-worker.mjs");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const workerId = process.env.TRUST_WORKER_ID ?? "w";

const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  taskQueue,
  workflowsPath: new URL("../../packages/orchestrator/dist/workflows.js", import.meta.url).pathname,
  activities: {
    // The production activity NAME, so the real workflow's `proxyActivities<Activities>()` binding resolves.
    async dispatchCase(job) {
      await pool.query(
        `INSERT INTO everdict_trust_temporal_effects (task_queue, worker_id, case_id, at) VALUES ($1,$2,$3, now())`,
        [taskQueue, workerId, job.evalCase?.id ?? "?"],
      );
      // Long enough that the scenario can kill this worker WHILE the activity is in flight — the state the
      // replay guarantee is actually about.
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      return {
        caseId: job.evalCase?.id ?? "?",
        harness: "trust@1",
        trace: [],
        scores: [],
        snapshot: { kind: "prompt", output: `settled by ${workerId}` },
      };
    },
  },
});
console.log(`[trust-worker] ${workerId} polling ${taskQueue}`);
await worker.run();
