#!/usr/bin/env node
// A REAL batch worker: this repository's built workflow module AND its built activity implementations
// (docs/trust-certification.md — TRUST-143).
//
// The distinction from TRUST-140's worker matters. That one supplied its own `dispatchCase` because what it
// certified was the workflow's replay. This one supplies NOTHING: `createActivities` is the production
// factory, so `runBatchCase` is the real activity — the same HTTP bridge, the same heartbeat wrapper, the
// same retry policy an operator's worker runs. Only the far side of the bridge is the scenario's, because a
// control plane that can be made to hang on demand is the one thing a certification needs and production
// cannot offer.
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(new URL("../../packages/orchestrator/package.json", import.meta.url));
const { NativeConnection, Worker } = await import(new URL(require.resolve("@temporalio/worker"), "file:").href);
const { createActivities } = await import(
  new URL("../../packages/orchestrator/dist/activities.js", import.meta.url).href
);

const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const taskQueue = process.env.TRUST_TASK_QUEUE;
const apiUrl = process.env.EVERDICT_API_URL;
const internalToken = process.env.EVERDICT_INTERNAL_TOKEN;
if (!taskQueue || !apiUrl || !internalToken) {
  console.error("usage: TRUST_TASK_QUEUE=… EVERDICT_API_URL=… EVERDICT_INTERNAL_TOKEN=… temporal-batch-worker.mjs");
  process.exit(2);
}

// The dispatcher the production factory takes. This scenario never dispatches a case through it — the batch
// seam runs entirely over the internal bridge — so a dispatcher that throws is the honest wiring: if the
// workflow ever reached it, that would be the scenario testing something other than what it claims.
const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  taskQueue,
  workflowsPath: new URL("../../packages/orchestrator/dist/workflows.js", import.meta.url).pathname,
  activities: createActivities(
    {
      dispatch: async () => {
        throw new Error("the batch seam must not reach the dispatcher — this scenario drives the HTTP bridge");
      },
    },
    { apiUrl, internalToken },
  ),
});
console.log(`[trust-batch-worker] polling ${taskQueue} → ${apiUrl}`);
await worker.run();
