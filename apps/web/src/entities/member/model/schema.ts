import { z } from 'zod'

// 컨트롤플레인 GET /members 응답 미러. subject 는 opaque Keycloak sub; email 은 표시용(있을 때).
export const memberSchema = z.object({
  subject: z.string(),
  role: z.string(),
  email: z.string().optional(),
  addedAt: z.string(),
})
export type Member = z.infer<typeof memberSchema>
export const membersSchema = z.array(memberSchema)

// 대기중 초대(메타만 — 토큰/해시 없음). GET /invites 미러.
export const inviteSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  role: z.string(),
  createdBy: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  accepted: z.boolean(),
})
export type Invite = z.infer<typeof inviteSchema>
export const invitesSchema = z.array(inviteSchema)

// POST /invites 응답 — meta + 평문 토큰(inv_…, 1회 노출).
export const createdInviteSchema = inviteSchema.extend({ token: z.string() })
export type CreatedInvite = z.infer<typeof createdInviteSchema>

// POST /invites/accept 응답.
export const acceptedInviteSchema = z.object({ workspace: z.string(), role: z.string() })
export type AcceptedInvite = z.infer<typeof acceptedInviteSchema>
