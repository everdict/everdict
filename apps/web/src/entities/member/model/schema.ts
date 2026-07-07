import { z } from 'zod'

// Mirror of the control plane GET /members response. subject is the opaque Keycloak sub (not displayed);
// name/email/avatarUrl are profile enrichment (human-readable identity) — only when present.
export const memberSchema = z.object({
  subject: z.string(),
  role: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
  addedAt: z.string(),
})
export type Member = z.infer<typeof memberSchema>
export const membersSchema = z.array(memberSchema)

// Pending invite (meta only — no token/hash). Mirror of GET /invites.
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

// POST /invites response — meta + plaintext token (inv_…, exposed once).
export const createdInviteSchema = inviteSchema.extend({ token: z.string() })
export type CreatedInvite = z.infer<typeof createdInviteSchema>

// POST /invites/accept response.
export const acceptedInviteSchema = z.object({ workspace: z.string(), role: z.string() })
export type AcceptedInvite = z.infer<typeof acceptedInviteSchema>

// GET /invites/preview response — "which workspace" on the link landing (name·thumbnail·role). Non-consuming.
export const invitePreviewSchema = z.object({
  workspace: z.string(),
  name: z.string(),
  logoUrl: z.string().optional(),
  role: z.string(),
})
export type InvitePreview = z.infer<typeof invitePreviewSchema>
