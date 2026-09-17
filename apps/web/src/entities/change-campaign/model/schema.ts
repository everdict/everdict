import type { ChangeCampaignRecord, ChangeRound as WireChangeRound } from '@everdict/contracts'
import { z } from 'zod'

// A local mirror of the control plane's `change` grade (apps/api `/change-campaigns`). Mirrored rather than
// imported: the web is a pure HTTP client, so runtime validation is this file's zod v4 — but the EXPORTED type
// is the wire record, and the guard at the bottom is what makes the mirror a mirror rather than a copy.
export const gateRunSchema = z.object({
  id: z.string(),
  command: z.string(),
  exitCode: z.number(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  metrics: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string().optional() })),
})

export const changeRoundSchema = z.object({
  seq: z.number(),
  hypothesis: z.string(),
  changes: z.array(
    z.object({
      repository: z.string(),
      path: z.string().optional(),
      commits: z.array(
        z.object({ sha: z.string(), message: z.string().optional(), at: z.string().optional() })
      ),
      pr: z
        .object({
          number: z.number(),
          url: z.string().optional(),
          mergedSha: z.string().optional(),
        })
        .optional(),
    })
  ),
  gateRuns: z.array(gateRunSchema).default([]),
  judgement: z.object({
    at: z.string(),
    by: z.string(),
    checkpointId: z.string().optional(),
    answers: z.array(
      z.object({
        criterionId: z.string(),
        answer: z.enum(['met', 'not_met', 'not_run']),
        how: z.enum(['observed', 'asserted']),
        detail: z.string().optional(),
        gateRunIds: z.array(z.string()).default([]),
      })
    ),
  }),
  outcome: z.enum(['adopted', 'rejected']),
  learned: z.string().optional(),
})

export const changeCampaignSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  issueId: z.string(),
  service: z.object({ repository: z.string(), path: z.string().optional() }),
  continues: z.string().optional(),
  criteria: z.array(z.object({ id: z.string(), statement: z.string() })),
  rounds: z.array(changeRoundSchema).default([]),
  state: z.enum(['open', 'adopted', 'partially_adopted', 'abandoned']),
  close: z
    .object({
      at: z.string(),
      by: z.string(),
      state: z.enum(['adopted', 'partially_adopted', 'abandoned']),
      reason: z.string(),
      roundSeq: z.number().optional(),
      landed: z
        .array(z.object({ repository: z.string(), path: z.string().optional() }))
        .default([]),
      remaining: z
        .array(z.object({ repository: z.string(), path: z.string().optional() }))
        .default([]),
      knowledge: z.array(z.string()).default([]),
      knowledgeDeclined: z.string().optional(),
    })
    .optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// Drift guard — the local schema and the wire contract stay mutually assignable, so a RENAMED field, a
// DROPPED field or a RETYPE on either side stops one of these bindings compiling and the web typecheck fails.
//
// What it does NOT catch, stated because the shape makes it look as though it does: a wire field added as
// OPTIONAL satisfies both directions (optional on one side, excess-property on a non-fresh type on the
// other), and this non-strict `z.object` then drops it at parse time. The screen renders as though the
// control plane never sent it. Adding a field here is therefore a step in adding one there, not something the
// compiler will remind anybody about.
type AssertAssignable<A extends B, B> = A
type WebChangeCampaign = z.infer<typeof changeCampaignSchema>
type WebChangeRound = z.infer<typeof changeRoundSchema>
type _campaignFwd = AssertAssignable<WebChangeCampaign, ChangeCampaignRecord>
type _campaignBack = AssertAssignable<ChangeCampaignRecord, WebChangeCampaign>
type _roundFwd = AssertAssignable<WebChangeRound, WireChangeRound>
type _roundBack = AssertAssignable<WireChangeRound, WebChangeRound>

export type ChangeCampaign = ChangeCampaignRecord
export type ChangeRound = WireChangeRound

// Reference the guards so unused-type lint never strips them.
export type __changeCampaignDriftGuard = [_campaignFwd, _campaignBack, _roundFwd, _roundBack]

export const changeCampaignHref = (workspace: string, id: string) =>
  `/${workspace}/change-campaign/${id}`
