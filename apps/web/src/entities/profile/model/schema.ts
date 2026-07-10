import type { UserProfileResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED type is anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Control plane GET /me.profile + PATCH /me/profile response (user profile). email is not here — being an SSO claim,
// it comes from Principal.email (read-only). Mirrors the API shape with zod.
export const profileSchema = z.object({
  subject: z.string(),
  name: z.string().optional(),
  username: z.string().optional(),
  avatarUrl: z.string().optional(),
  updatedAt: z.string(),
})

// Drift guard — identical-shape entity (subject/name/username/avatarUrl/updatedAt), so the guard is
// bidirectional: a renamed/dropped/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebProfile = z.infer<typeof profileSchema>
type _profileFwd = AssertAssignable<WebProfile, UserProfileResponse>
type _profileBack = AssertAssignable<UserProfileResponse, WebProfile>

// Exported name aliases the contract type (consumers untouched: same Profile identifier).
export type Profile = UserProfileResponse

export type __profileDriftGuard = [_profileFwd, _profileBack]
