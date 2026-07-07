import { fileURLToPath } from "node:url";
import { collectAuthEnv } from "@everdict/agent";
import { BackendRegistry, type BackendsConfig, LocalBackend, Scheduler, buildRegistry } from "@everdict/backends";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./constants.js";

export interface WorkerOptions {
  address?: string; // Temporal address (default localhost:7233)
  taskQueue?: string;
  config?: BackendsConfig; // backend declarations (a single local if absent)
  maxQueueDepth?: number; // scheduler backpressure (unlimited by default)
}

// Control-plane worker: holds a capacity-aware Scheduler (backend registry) and registers activities+workflows to
// poll the task queue. The scheduler places jobs based on backend availability and queues them when there's no room.
// A long-running process. (Launched with `everdict worker`)
export async function runWorker(opts: WorkerOptions = {}): Promise<void> {
  const { registry } = opts.config
    ? buildRegistry(opts.config, { secretEnv: collectAuthEnv() })
    : { registry: new BackendRegistry().register("local", new LocalBackend()) };
  const scheduler = new Scheduler(registry, { maxQueueDepth: opts.maxQueueDepth });

  // Scheduled-fire activities — bridge to the control-plane internal routes (active only when both are set; for scheduledScorecardWorkflow only).
  const apiUrl = process.env.EVERDICT_API_URL;
  const internalToken = process.env.EVERDICT_INTERNAL_TOKEN;
  const scheduleApi = apiUrl && internalToken ? { apiUrl, internalToken } : undefined;

  const connection = await NativeConnection.connect({ address: opts.address ?? "localhost:7233" });
  try {
    const worker = await Worker.create({
      connection,
      taskQueue: opts.taskQueue ?? TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
      activities: createActivities(scheduler, scheduleApi),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}
