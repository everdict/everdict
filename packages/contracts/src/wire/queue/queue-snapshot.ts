import { z } from "zod";

// GET /queue — the work-queue snapshot (core/queue/queue-service.ts QueueSnapshot): what is running /
// waiting where (which runtime lane) right now, and what fires next. Batch = 1 item with progress.

const QueueItemSchema = z.object({
  type: z.enum(["scorecard", "run"]),
  id: z.string(),
  status: z.enum(["queued", "running"]),
  dataset: z.object({ id: z.string(), version: z.string() }).optional().describe("Scorecards only"),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string().optional().describe("Standalone runs only"),
  trigger: z.string().optional().describe("Where it was fired from (web|api|schedule|scorecard…)"),
  createdBy: z.string().optional().describe("The runner subject (if any)"),
  createdAt: z.string(),
  progress: z
    .object({
      done: z.number().int().describe("Finished (succeeded+failed) children"),
      active: z.number().int().describe("Running children (a runner is actually executing them)"),
      waiting: z.number().int().describe("Queued children (parked, waiting for a runner/backend slot)"),
      total: z.number().int().optional().describe("Dataset case count (omitted if resolution fails)"),
    })
    .optional()
    .describe("Batch progress (running scorecards only)"),
});

const QueueUpcomingSchema = z.object({
  scheduleId: z.string(),
  name: z.string(),
  at: z.string().describe("Next fire time (ISO, Temporal authoritative)"),
  dataset: z.string(),
  harness: z.string(),
});

const QueueLaneAdmissionSchema = z.object({
  inFlight: z.number().int().describe("Scheduler-tracked dispatches currently on this lane's backend(s)"),
  memInFlightMb: z.number().optional().describe("Sum of in-flight harness-declared memory (MB)"),
  memoryBudgetMb: z.number().optional().describe("The runtime's declared memory envelope (RuntimeSpec)"),
  cpuInFlight: z.number().optional().describe("Sum of in-flight harness-declared cpu (1000 = 1 vCPU)"),
  cpuBudget: z.number().optional().describe("The runtime's declared cpu envelope (RuntimeSpec)"),
  maxConcurrent: z.number().int().optional().describe("The runtime's declared slot cap (RuntimeSpec)"),
  circuit: z
    .object({ open: z.boolean(), consecutive: z.number().int() })
    .optional()
    .describe("Spillover breaker state (open = dispatches skip this runtime)"),
});

const QueueLaneSchema = z.object({
  runtime: z.string().describe("Lane key: '' = default backend, 'self:<runnerId>' = self-hosted, else runtime id"),
  label: z.string().optional().describe("Human-readable label (personal lane = runner hostname)"),
  registered: z.boolean().describe("Whether the lane is registered in the runtime registry"),
  admission: QueueLaneAdmissionSchema.optional().describe(
    "Scheduler admission view (absent for self-hosted lanes — those are lease queues)",
  ),
  running: z.array(QueueItemSchema).describe("Oldest first"),
  queued: z.array(QueueItemSchema).describe("FIFO — the front is the next item"),
  upcoming: z.array(QueueUpcomingSchema).describe("Next fires of active schedules aimed at this lane"),
});

export const QueueSnapshotResponseSchema = z.object({
  generatedAt: z.string(),
  totals: z.object({
    running: z.number().int(),
    queued: z.number().int(),
    upcoming: z.number().int(),
  }),
  scheduler: z
    .object({
      queued: z.number().int(),
      inFlight: z.number().int(),
      quota: z.number().optional().describe("Operator per-tenant quota when dialed in"),
    })
    .optional()
    .describe("THIS workspace's control-plane scheduler slice (never another tenant's numbers)"),
  workspace: z.array(QueueLaneSchema).describe("Shared lanes: default backend + registered runtimes"),
  personal: z.array(QueueLaneSchema).describe("The requester's own self-hosted runner lanes (self:<id>)"),
});
export type QueueSnapshotResponse = z.infer<typeof QueueSnapshotResponseSchema>;
