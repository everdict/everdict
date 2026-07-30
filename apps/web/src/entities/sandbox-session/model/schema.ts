import { z } from 'zod'

import { runSchema, traceEventSchema } from '@/entities/run'

// Sandbox session read models (the harness playground). A session is a `kind: "sandbox"`, `lifetime: "session"`
// RUN — so the record half reuses runSchema verbatim (entity→entity, same layer) rather than mirroring it again.
// `live` is the control-plane-local half: it exists only while the session is held open on THIS control plane, so
// its absence is the signal that the session settled (closed / expired) or was lost to a restart.
//
// These stay web-local zod v4 mirrors of @everdict/application-control's SandboxSessionView / SandboxTaskSummary /
// SandboxTaskTrace. They are NOT drift-guarded against a contract type: the shapes live in the application layer,
// which the web may not depend on (only @everdict/contracts is permitted), so there is nothing to anchor to.

// One submitted test case, as the session reports it — enough for the feed's card head without the trace.
export const sandboxTaskSummarySchema = z.object({
  runId: z.string(),
  caseId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  taskPreview: z.string(),
  submittedAt: z.string(),
  eventCount: z.number(),
})
export type SandboxTaskSummary = z.infer<typeof sandboxTaskSummarySchema>

export const sandboxSessionViewSchema = z.object({
  record: runSchema,
  live: z
    .object({
      expiresAt: z.string(),
      busy: z.boolean(), // a task is running — the composer waits rather than racing a 409
      harness: z.object({ id: z.string(), version: z.string() }).optional(),
      tasks: z.array(sandboxTaskSummarySchema),
    })
    .optional(),
})
export type SandboxSessionView = z.infer<typeof sandboxSessionViewSchema>

export const sandboxListSchema = z.object({
  sessions: z.array(sandboxSessionViewSchema),
})
export type SandboxList = z.infer<typeof sandboxListSchema>

// One page of a task's trace. `nextCursor` is the index to poll from next; `done` = terminal, stop polling
// (the same events then serve from the sealed trajectory, so a late replay still works).
export const sandboxTaskTraceSchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  events: z.array(traceEventSchema),
  nextCursor: z.number(),
  done: z.boolean(),
})
export type SandboxTaskTrace = z.infer<typeof sandboxTaskTraceSchema>
