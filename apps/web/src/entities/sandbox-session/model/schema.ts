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
  fresh: z.boolean().optional(), // conversation sessions only: this turn deliberately started a new thread
})
export type SandboxTaskSummary = z.infer<typeof sandboxTaskSummarySchema>

export const sandboxSessionViewSchema = z.object({
  record: runSchema,
  live: z
    .object({
      expiresAt: z.string(),
      busy: z.boolean(), // a task is running — the composer waits rather than racing a 409
      // kind is the panel's ONE branch signal: process/command = a container harness, service = a front-door
      // conversation over a warm topology. Loose string — the control plane owns the vocabulary.
      harness: z
        .object({ id: z.string(), version: z.string(), kind: z.string().optional() })
        .optional(),
      // true = the task feed is one CONVERSATION (turns), not independent cases — the chat-shaped feed.
      conversation: z.boolean().optional(),
      // 위임 프로필로 부팅된 세션이면 그 상대 — 어떤 하네스 바이너리가 도는지가 아니라 WHO에게 맡겼는지를
      // 화면이 말할 수 있게(컨트롤플레인이 resolved 버전까지 실어 보낸다; 툴 인자에는 버전이 없다).
      profile: z.object({ source: z.string(), id: z.string(), version: z.string() }).optional(),
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
