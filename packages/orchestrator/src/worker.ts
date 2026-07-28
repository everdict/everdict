import { fileURLToPath } from "node:url";
import { BackendRegistry, type BackendsConfig, LocalBackend, Scheduler, buildRegistry } from "@everdict/backends";
import { collectAuthEnv } from "@everdict/job-runner";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./constants.js";
import { installProxyDispatcher } from "./proxy-dispatcher.js";

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
  // Proxy-aware outbound: install a global dispatcher FIRST (before any client fetches) so the activities' external
  // calls (trace pull from tenant observability platforms, tenant-registered cluster APIs) honor HTTP(S)_PROXY /
  // NO_PROXY behind a corporate proxy. No-op when no proxy env is set.
  const proxy = installProxyDispatcher();
  if (proxy) console.log(`[everdict-worker] outbound proxy: ${proxy.httpsProxy ?? proxy.httpProxy} (NO_PROXY honored)`);

  const { registry } = opts.config
    ? buildRegistry(opts.config, { secretEnv: collectAuthEnv() })
    : { registry: new BackendRegistry().register("local", new LocalBackend()) };
  const scheduler = new Scheduler(registry, { maxQueueDepth: opts.maxQueueDepth });

  // Scheduled-fire activities — bridge to the control-plane internal routes (active only when both are set; for scheduledScorecardWorkflow only).
  const apiUrl = process.env.EVERDICT_API_URL;
  const internalToken = process.env.EVERDICT_INTERNAL_TOKEN;
  // Internal-bridge response ceiling (ms; 0 disables) — the batch-case call holds the response for a WHOLE eval
  // case, so this must never fall back to undici's 300s default (see ScheduleActivityConfig.headersTimeoutMs).
  const timeoutRaw = Number(process.env.EVERDICT_INTERNAL_HTTP_TIMEOUT_MS ?? "");
  const headersTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 0 ? timeoutRaw : undefined;
  const scheduleApi =
    apiUrl && internalToken
      ? { apiUrl, internalToken, ...(headersTimeoutMs !== undefined ? { headersTimeoutMs } : {}) }
      : undefined;

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
