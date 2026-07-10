import type { QueueSnapshotResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
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

export const queueUpcomingSchema = z.object({
  scheduleId: z.string(),
  name: z.string(),
  at: z.string(),
  dataset: z.string(),
  harness: z.string(),
})

// Scheduler admission view of a lane — in-flight dispatches, the declared memory envelope, and the spillover
// circuit state (open = the control plane is currently routing around this runtime).
export const queueLaneAdmissionSchema = z.object({
  inFlight: z.number(),
  memInFlightMb: z.number().optional(),
  memoryBudgetMb: z.number().optional(),
  cpuInFlight: z.number().optional(),
  cpuBudget: z.number().optional(),
  maxConcurrent: z.number().optional(),
  circuit: z.object({ open: z.boolean(), consecutive: z.number() }).optional(),
})

export const queueLaneSchema = z.object({
  runtime: z.string(), // '' = default backend, 'self:<id>' = self-hosted runner
  label: z.string().optional(), // human-readable label (personal lane = runner hostname)
  registered: z.boolean(),
  admission: queueLaneAdmissionSchema.optional(), // absent for self-hosted lanes (lease queues)
  running: z.array(queueItemSchema),
  queued: z.array(queueItemSchema), // FIFO — the front is the next job
  upcoming: z.array(queueUpcomingSchema),
})

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

// Drift guard — QueueSnapshot is identical-shape (the web models every wire field of the snapshot and its
// nested lanes/items and no extra), so the top-level guard is bidirectional: a renamed/added field or a widened
// enum anywhere in the tree on EITHER side fails the web typecheck. (int()-branded wire numbers still infer
// `number`, matching the web's plain numbers.)
type AssertAssignable<A extends B, B> = A
type WebQueueSnapshot = z.infer<typeof queueSnapshotSchema>
type _snapshotFwd = AssertAssignable<WebQueueSnapshot, QueueSnapshotResponse>
type _snapshotBack = AssertAssignable<QueueSnapshotResponse, WebQueueSnapshot>

// Exported names alias the contract types; the sub-shapes are nested anonymously on the wire snapshot, so they
// are derived FROM it (consumers untouched: same identifiers).
export type QueueSnapshot = QueueSnapshotResponse
export type QueueLane = QueueSnapshotResponse['workspace'][number]
export type QueueLaneAdmission = NonNullable<QueueLane['admission']>
export type QueueItem = QueueLane['running'][number]
export type QueueUpcoming = QueueLane['upcoming'][number]

export type __queueDriftGuard = [_snapshotFwd, _snapshotBack]
