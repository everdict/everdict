import { z } from 'zod'

// 컨트롤플레인 GET /me.profile + PATCH /me/profile 응답(유저 프로필). email 은 여기 없다 — SSO 클레임이라
// Principal.email(읽기전용)에서 온다. API 모양을 zod 로 미러.
export const profileSchema = z.object({
  subject: z.string(),
  name: z.string().optional(),
  username: z.string().optional(),
  avatarUrl: z.string().optional(),
  updatedAt: z.string(),
})
export type Profile = z.infer<typeof profileSchema>
