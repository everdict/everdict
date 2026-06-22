import { z } from 'zod'

// 컨트롤플레인 GET /workspaces 항목(내가 멤버인 워크스페이스 + 내 역할). API 모양을 zod 로 미러.
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
})
export type Workspace = z.infer<typeof workspaceSchema>

export const workspacesSchema = z.array(workspaceSchema)
