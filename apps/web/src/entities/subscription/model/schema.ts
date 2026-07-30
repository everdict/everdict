import type { SubscriptionRecord } from '@everdict/contracts'
import { z } from 'zod'

import { agentTriggerFilterSchema, TRIGGERABLE_EVENT_KINDS } from '@/entities/agent-spec'

// Subscription — the E3 registry's rule: selector (event kinds + payload filters) → reaction
// (agent | webhook | workflow) under governance (enabled + cooldown). Runtime boundary validation stays
// here (zod v4); the EXPORTED type comes from @everdict/contracts (`import type` only). The selector
// reuses the agent-trigger grammar the agent-spec entity already mirrors (same server vocabulary).
export const subscriptionSelectorSchema = z.object({
  kinds: z.array(z.enum(TRIGGERABLE_EVENT_KINDS)).min(1),
  filters: z.array(agentTriggerFilterSchema),
})

export const subscriptionWorkflowStepSchema = z.object({
  agentId: z.string().min(1),
  instruction: z.string().min(1).max(2000).optional(),
})

export const subscriptionReactionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }),
  z.object({
    kind: z.literal('webhook'),
    url: z.string().url(),
    secret: z.string().min(8).max(200).optional(),
  }),
  z.object({
    kind: z.literal('workflow'),
    steps: z.array(subscriptionWorkflowStepSchema).min(1).max(5),
  }),
])

export const subscriptionGovernanceSchema = z.object({
  enabled: z.boolean(),
  cooldownSec: z.number().int().min(0).max(86_400).optional(),
})

export const subscriptionSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1).max(120),
  selector: subscriptionSelectorSchema,
  reaction: subscriptionReactionSchema,
  governance: subscriptionGovernanceSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const subscriptionsSchema = z.array(subscriptionSchema)

// Drift guard — the local schema and the wire contract MUST stay mutually assignable (a server-side kind
// or field change stops this compiling, forcing the lockstep update).
type AssertAssignable<A extends B, B> = A
type WebSubscription = z.infer<typeof subscriptionSchema>
type _fwd = AssertAssignable<WebSubscription, SubscriptionRecord>
type _back = AssertAssignable<SubscriptionRecord, WebSubscription>

export type Subscription = SubscriptionRecord
export type SubscriptionReaction = Subscription['reaction']

// Reference the guards so unused-type lint never strips them.
export type __subscriptionDriftGuard = [_fwd, _back]
