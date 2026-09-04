import type { PlatformEventRecord } from '@everdict/contracts'
import { z } from 'zod'

// GET /events 200 — the workspace's platform event (lifecycle fact) log. Consumed by the crafting studio's replay picker and the fleet event
// feed. `kind` is a looser string than the server enum (so adding a new kind does not break the web) —
// only the REVERSE drift guard is applied (a deliberately-loose consumer view).
export const platformEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  tenant: z.string(),
  kind: z.string(),
  subject: z.object({ type: z.string(), id: z.string() }),
  actor: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  causedBy: z.string().optional(),
  message: z.string(),
  createdAt: z.string(),
})
export type PlatformEvent = z.infer<typeof platformEventSchema>

export const platformEventListSchema = z.object({ events: z.array(platformEventSchema) })

// The drift guard (reverse) — the contract record must always be assignable to the web view (a renamed or deleted field fails the typecheck).
type AssertAssignable<A extends B, B> = A
type _eventBack = AssertAssignable<PlatformEventRecord, PlatformEvent>
export type __platformEventDriftGuard = [_eventBack]
