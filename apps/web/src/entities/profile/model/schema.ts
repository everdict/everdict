import { z } from 'zod'

// Control plane GET /me.profile + PATCH /me/profile response (user profile). email is not here — being an SSO claim,
// it comes from Principal.email (read-only). Mirrors the API shape with zod.
export const profileSchema = z.object({
  subject: z.string(),
  name: z.string().optional(),
  username: z.string().optional(),
  avatarUrl: z.string().optional(),
  updatedAt: z.string(),
})
export type Profile = z.infer<typeof profileSchema>
