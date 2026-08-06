import { z } from "zod";
import { AgentReferenceTypeSchema } from "./agent-session.js";

// The DELEGATION BRIEF — the context contract when everdict hands work to another agent environment.
//
// Delegation used to have exactly one channel: a prompt string. Everything that makes a handoff reproducible —
// what must be true when this is done, which evidence is being handed over, what the delegate must NOT do —
// had to be crammed into prose, and none of it survived as evidence. The brief is that handoff made
// structured: it is materialized INTO the delegate's sandbox (so the delegate reads it as a file, not only as
// a sentence it might lose from context) and stamped on the session's trajectory (so the ledger alone answers
// "what were they actually asked to do").
//
// The reference TYPE vocabulary is the agent's own (AGENT_REFERENCE_TYPES) — what everdict can point at has
// ONE answer, never a second list that drifts. The display `label` an @-mention carries is deliberately absent:
// a brief names WHAT is handed over, and whoever renders it resolves the title itself.
export const DelegationReferenceSchema = z.object({
  type: AgentReferenceTypeSchema,
  id: z.string().min(1),
  version: z.string().optional(),
  note: z.string().optional(), // why THIS is in the brief ("the case that regressed", "the failing trace")
});
export type DelegationReference = z.infer<typeof DelegationReferenceSchema>;

export const DelegationBriefSchema = z.object({
  goal: z.string().min(1), // what must be true when this is done — the one required field
  context: z.string().optional(), // background prose: what happened, what has been tried
  references: z.array(DelegationReferenceSchema).default([]), // the evidence handed over
  constraints: z.array(z.string()).default([]), // what the delegate must not do / must preserve
  doneWhen: z.array(z.string()).default([]), // the checks the delegator will apply to the result
});
export type DelegationBrief = z.infer<typeof DelegationBriefSchema>;
