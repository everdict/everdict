import { z } from 'zod'

// The parked agent mutation a member decides. Mirrors `ApprovalRecordSchema` on the wire; `requestId` is
// deliberately absent — the control plane's own comment calls it "the in-process registry key, live-delivery
// correlation, never shown as identity", and a page that rendered it would be showing plumbing.
export const approvalSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  request: z.object({ name: z.string(), input: z.unknown().optional() }),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  // The days-long wait bound. A queue that does not show it hides the fact that NOT deciding is itself a
  // decision — an expired approval is denied.
  expiresAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Approval = z.infer<typeof approvalSchema>
export const approvalListSchema = z.array(approvalSchema)
