import type {
  AcceptedInviteResponse,
  InviteMetaResponse,
  InvitePreviewResponse,
  MemberResponse,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.

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
export const membersSchema = z.array(memberSchema)

// Active invite link (meta only — no token/hash). Mirror of GET /invites. Reusable: acceptedCount = joins so far;
// the link works until it expires or an admin revokes it. Identical shape to the wire InviteMetaResponse.
export const inviteSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  role: z.string(),
  createdBy: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  acceptedCount: z.number(),
})
export type Invite = z.infer<typeof inviteSchema>
export const invitesSchema = z.array(inviteSchema)

// POST /invites response — meta + plaintext token (inv_…, exposed once).
export const createdInviteSchema = inviteSchema.extend({ token: z.string() })
export type CreatedInvite = z.infer<typeof createdInviteSchema>

// POST /invites/accept response.
export const acceptedInviteSchema = z.object({ workspace: z.string(), role: z.string() })

// GET /invites/preview response — "which workspace" on the link landing (name·thumbnail·role). Non-consuming.
export const invitePreviewSchema = z.object({
  workspace: z.string(),
  name: z.string(),
  logoUrl: z.string().optional(),
  role: z.string(),
})

// Drift guards.
// Member/AcceptedInvite/InvitePreview/Invite are identical-shape to their wire types, so they guard bidirectionally.
//   _inviteFwd          — web ⊆ wire: a required-field retype/rename fails here.
//   _inviteFieldsOnWire — every field the web models must exist on the wire with an assignable type (Pick the wire
//                         down to the web keys, require it back-assignable): catches a wire field rename the web
//                         still models. CreatedInvite (Invite + token) rides the same guards via extension.
type AssertAssignable<A extends B, B> = A
type WebMember = z.infer<typeof memberSchema>
type WebInvite = z.infer<typeof inviteSchema>
type WebAcceptedInvite = z.infer<typeof acceptedInviteSchema>
type WebInvitePreview = z.infer<typeof invitePreviewSchema>
type _memberFwd = AssertAssignable<WebMember, MemberResponse>
type _memberBack = AssertAssignable<MemberResponse, WebMember>
type _inviteFwd = AssertAssignable<WebInvite, InviteMetaResponse>
type _inviteFieldsOnWire = AssertAssignable<Pick<InviteMetaResponse, keyof WebInvite>, WebInvite>
type _acceptedFwd = AssertAssignable<WebAcceptedInvite, AcceptedInviteResponse>
type _acceptedBack = AssertAssignable<AcceptedInviteResponse, WebAcceptedInvite>
type _previewFwd = AssertAssignable<WebInvitePreview, InvitePreviewResponse>
type _previewBack = AssertAssignable<InvitePreviewResponse, WebInvitePreview>

// Exported names alias the contract types where identical; Invite/CreatedInvite keep their narrower web shape
// (anchored by the guards above).
export type Member = MemberResponse
export type AcceptedInvite = AcceptedInviteResponse
export type InvitePreview = InvitePreviewResponse

export type __memberDriftGuard = [
  _memberFwd,
  _memberBack,
  _inviteFwd,
  _inviteFieldsOnWire,
  _acceptedFwd,
  _acceptedBack,
  _previewFwd,
  _previewBack,
]
