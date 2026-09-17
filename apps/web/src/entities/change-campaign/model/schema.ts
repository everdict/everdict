import type { ChangeCampaignView, ChangeRound as WireChangeRound } from '@everdict/contracts'
import { z } from 'zod'

// A local mirror of the control plane's `change` grade (apps/api `/change-campaigns`). Mirrored rather than
// imported: the web is a pure HTTP client, so runtime validation is this file's zod v4 — but the EXPORTED type
// is the wire record, and the guard at the bottom is what makes the mirror a mirror rather than a copy.
// The closed vocabulary for "why not". A free-text reason could not be counted, and counting is the point —
// only `attempted_and_failed` means "do the work again"; the rest name something to go and get.
export const unmetReasonSchema = z.enum([
  'attempted_and_failed',
  'needs_information',
  'needs_environment',
  'blocked_elsewhere',
  'descoped',
])
export type UnmetReason = z.infer<typeof unmetReasonSchema>

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
    // `reason` travels with the answer rather than beside it: an unmet criterion with no reason is
    // unrepresentable on the wire, and the screen reads the union the same way the contract writes it.
    answers: z.array(
      z.discriminatedUnion('answer', [
        z.object({
          answer: z.literal('met'),
          criterionId: z.string(),
          how: z.enum(['observed', 'asserted']),
          detail: z.string().optional(),
          gateRunIds: z.array(z.string()).default([]),
        }),
        z.object({
          answer: z.literal('not_met'),
          reason: unmetReasonSchema,
          criterionId: z.string(),
          how: z.enum(['observed', 'asserted']),
          detail: z.string().optional(),
          gateRunIds: z.array(z.string()).default([]),
        }),
        z.object({
          answer: z.literal('not_run'),
          reason: unmetReasonSchema,
          criterionId: z.string(),
          how: z.enum(['observed', 'asserted']),
          detail: z.string().optional(),
          gateRunIds: z.array(z.string()).default([]),
        }),
      ])
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
  // WHAT EACH CRITERION JUDGES. `requirement` answers one thing the request asked for (and names the issue,
  // normally a sub-issue); `quality` judges the change itself. `unclassified` exists only for criteria written
  // before the distinction did — the screen counts those apart rather than guessing which kind they were.
  criteria: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      judges: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('requirement'), issueId: z.string() }),
        z.object({ kind: z.literal('quality') }),
        z.object({ kind: z.literal('unclassified') }),
      ]),
    })
  ),
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
  // THE ACCOUNT THE REQUEST IS OWED, derived by the control plane on every read: how many things were asked
  // for, how many settled, and what is blocking each of the rest. Mirrored as REQUIRED — the guard below only
  // catches a dropped field when both sides require it, and a field this schema declares optional is one the
  // parse silently drops while the screen renders as though it was never sent.
  requirements: z.object({
    total: z.number(),
    settled: z.number(),
    unsettled: z.array(
      z.object({
        issueId: z.string(),
        criterionIds: z.array(z.string()),
        blockers: z.array(
          z.object({
            criterionId: z.string(),
            answer: z.enum(['not_met', 'not_run']),
            reason: unmetReasonSchema,
          })
        ),
      })
    ),
    unclassifiedCriteria: z.number(),
  }),
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
type _campaignFwd = AssertAssignable<WebChangeCampaign, ChangeCampaignView>
type _campaignBack = AssertAssignable<ChangeCampaignView, WebChangeCampaign>
type _roundFwd = AssertAssignable<WebChangeRound, WireChangeRound>
type _roundBack = AssertAssignable<WireChangeRound, WebChangeRound>

export type ChangeCampaign = ChangeCampaignView
export type ChangeRound = WireChangeRound

// Reference the guards so unused-type lint never strips them.
export type __changeCampaignDriftGuard = [_campaignFwd, _campaignBack, _roundFwd, _roundBack]

export const changeCampaignHref = (workspace: string, id: string) =>
  `/${workspace}/change-campaign/${id}`
