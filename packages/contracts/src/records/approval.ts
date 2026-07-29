import { z } from "zod";

// A parked agent mutation awaiting a human decision (agent-automation A6, execution-master-plan W2).
// Before this record, the park lived ONLY in the agent service's in-process registry (10-minute
// deny-on-expiry; a restart expired every ask as deny — the recorded v1 bound). The record is the durable
// half: the ask survives a restart, the decision has an audit line, and the approval:<id> workflow (T-a)
// owns the days-long WAIT + expiry on top of it. The agent loop stays in the agent service — `requestId`
// correlates this record back to the loop's in-process wait for live delivery.
export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  sessionId: z.string(), // the agent session whose turn parked
  agentId: z.string().optional(), // the registered agent behind a headless activation (unset for ad-hoc sessions)
  requestId: z.string(), // the in-process registry key — live-delivery correlation, never shown as identity
  request: z.object({
    name: z.string(), // the tool the agent asked to run
    input: z.unknown().optional(), // the tool input (pointer-sized by convention; the transcript holds the full ask)
  }),
  status: ApprovalStatusSchema,
  decidedBy: z.string().optional(), // the member who decided (unset for expiry / a legacy-channel decision)
  decidedAt: z.string().optional(),
  expiresAt: z.string(), // the days-long wait bound — enforced by the approval workflow (deny-on-expiry)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
