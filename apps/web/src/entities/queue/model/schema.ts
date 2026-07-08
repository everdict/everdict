import { z } from 'zod'

// Control plane GET /queue (QueueSnapshot) mirror — work queue: running/queued/next-scheduled per runtime lane.
// The unit is a batch (scorecard)=1 job (with progress) + a single run=1 job. Child runs collapse into the batch's progress.

export const queueItemSchema = z.object({
  type: z.enum(['scorecard', 'run']),
  id: z.string(),
  status: z.enum(['queued', 'running']),
  dataset: z.object({ id: z.string(), version: z.string() }).optional(), // scorecard only
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string().optional(), // single run only
  trigger: z.string().optional(), // where it was fired from (web|api|schedule|github-actions…)
  createdBy: z.string().optional(), // executor subject
  createdAt: z.string(),
  // batch progress (running scorecards only). total is omitted if dataset resolution fails.
  progress: z
    .object({ done: z.number(), active: z.number(), total: z.number().optional() })
    .optional(),
})
export type QueueItem = z.infer<typeof queueItemSchema>

export const queueUpcomingSchema = z.object({
  scheduleId: z.string(),
  name: z.string(),
  at: z.string(),
  dataset: z.string(),
  harness: z.string(),
})
export type QueueUpcoming = z.infer<typeof queueUpcomingSchema>

// Scheduler admission view of a lane — in-flight dispatches, the declared memory envelope, and the spillover
// circuit state (open = the control plane is currently routing around this runtime).
export const queueLaneAdmissionSchema = z.object({
  inFlight: z.number(),
  memInFlightMb: z.number().optional(),
  memoryBudgetMb: z.number().optional(),
  maxConcurrent: z.number().optional(),
  circuit: z.object({ open: z.boolean(), consecutive: z.number() }).optional(),
})
export type QueueLaneAdmission = z.infer<typeof queueLaneAdmissionSchema>

export const queueLaneSchema = z.object({
  runtime: z.string(), // '' = default backend, 'self:<id>' = self-hosted runner
  label: z.string().optional(), // human-readable label (personal lane = runner hostname)
  registered: z.boolean(),
  admission: queueLaneAdmissionSchema.optional(), // absent for self-hosted lanes (lease queues)
  running: z.array(queueItemSchema),
  queued: z.array(queueItemSchema), // FIFO — the front is the next job
  upcoming: z.array(queueUpcomingSchema),
})
export type QueueLane = z.infer<typeof queueLaneSchema>

// The queue has two scopes — workspace (shared runtimes: default backend + registered infra) / personal (my self-hosted runners).
export const queueSnapshotSchema = z.object({
  generatedAt: z.string(),
  totals: z.object({ running: z.number(), queued: z.number(), upcoming: z.number() }),
  // This workspace's control-plane scheduler slice (+ the operator quota when dialed in).
  scheduler: z
    .object({ queued: z.number(), inFlight: z.number(), quota: z.number().optional() })
    .optional(),
  workspace: z.array(queueLaneSchema),
  personal: z.array(queueLaneSchema),
})
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>
