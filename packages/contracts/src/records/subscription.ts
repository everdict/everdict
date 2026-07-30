import { z } from "zod";
import { AgentTriggerFilterSchema, TRIGGERABLE_EVENT_KINDS } from "../harness/agent-spec.js";

// Subscription registry (event-plumbing.md E3 §6): the ONE mechanism that turns a platform fact into a
// reaction. Selectors reuse the agent-trigger grammar (kinds + declarative payload filters) so a
// subscription and an agent trigger read identically; reactions are a closed union — each kind exists only
// with a live executor (agent = the activation engine, webhook = the E1 reaction consumer, workflow = the
// durable T-d `reaction:<eventId>` executor). Agent trigger fields stay on the spec until this shape holds
// (master-plan W6: relocation is a later rung, never a break).

export const SubscriptionSelectorSchema = z
  .object({
    kinds: z.array(z.enum(TRIGGERABLE_EVENT_KINDS)).min(1),
    filters: z.array(AgentTriggerFilterSchema).default([]),
  })
  .strict();
export type SubscriptionSelector = z.infer<typeof SubscriptionSelectorSchema>;

export const SUBSCRIPTION_REACTION_KINDS = ["agent", "webhook", "workflow"] as const;

// One durable multi-step chain link: wake this agent, hand it the event (plus an optional standing
// instruction), and only proceed to the next step once its run settles successfully.
export const SubscriptionWorkflowStepSchema = z
  .object({
    agentId: z.string().min(1),
    instruction: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type SubscriptionWorkflowStep = z.infer<typeof SubscriptionWorkflowStepSchema>;

export const SubscriptionReactionSchema = z.discriminatedUnion("kind", [
  // Wake one crafted agent — same activation path as the agent's own triggers (loop guards included).
  z
    .object({ kind: z.literal("agent"), agentId: z.string().min(1) })
    .strict(),
  // Deliver the fact to an external endpoint. `secret` (optional) HMAC-SHA256-signs the body
  // (x-everdict-signature) so the receiver can authenticate the sender.
  z
    .object({
      kind: z.literal("webhook"),
      url: z.string().url(),
      secret: z.string().min(8).max(200).optional(),
    })
    .strict(),
  // Durable multi-step reaction (orchestration.md T-d): the thin consumer starts one
  // `reaction:<eventId>:<subscriptionId>` workflow — the deterministic id IS the dedup — and the workflow
  // walks the steps, waiting out each agent run before the next.
  z
    .object({
      kind: z.literal("workflow"),
      steps: z.array(SubscriptionWorkflowStepSchema).min(1).max(5),
    })
    .strict(),
]);
export type SubscriptionReaction = z.infer<typeof SubscriptionReactionSchema>;

export const SubscriptionGovernanceSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Minimum spacing between fires of THIS subscription (overrides the executor's default guard).
    cooldownSec: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();
export type SubscriptionGovernance = z.infer<typeof SubscriptionGovernanceSchema>;

export const SubscriptionRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1).max(120),
  selector: SubscriptionSelectorSchema,
  reaction: SubscriptionReactionSchema,
  governance: SubscriptionGovernanceSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SubscriptionRecord = z.infer<typeof SubscriptionRecordSchema>;
