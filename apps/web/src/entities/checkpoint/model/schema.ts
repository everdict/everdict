import { z } from 'zod'

// A handoff checkpoint — the state transfer one agent leaves for the next. The fields the LIST needs are
// required; the heavy body (facts, hypotheses, decisions, the validation plan) is read on the detail page,
// because a list that loaded every transfer would carry a whole session's reasoning per row.
export const checkpointSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  envelopeId: z.string().optional(),
  goal: z.string(),
  role: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  // The verification an independent verifier produced, when one has been asked for. Absent means NOT ASKED
  // — which is different from "asked and inconclusive", and the detail page draws them differently.
  verification: z
    .object({ status: z.string(), at: z.string().optional(), detail: z.string().optional() })
    .passthrough()
    .optional(),
})
export type Checkpoint = z.infer<typeof checkpointSchema>
export const checkpointListSchema = z.array(checkpointSchema)

// The detail adds the transfer itself. Loose on the inner shapes on purpose: the page renders them as
// evidence to read, and mirroring the agent runtime's whole vocabulary here would put a second copy of it
// in the web.
export const checkpointDetailSchema = checkpointSchema.extend({
  facts: z.array(z.object({}).passthrough()).default([]),
  hypotheses: z.array(z.object({}).passthrough()).default([]),
  decisions: z.array(z.object({}).passthrough()).default([]),
  remaining: z.array(z.object({}).passthrough()).default([]),
})
export type CheckpointDetail = z.infer<typeof checkpointDetailSchema>
