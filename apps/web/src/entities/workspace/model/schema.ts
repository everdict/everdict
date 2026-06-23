import { z } from 'zod'

// 컨트롤플레인 GET /workspaces 항목(내가 멤버인 워크스페이스 + 내 역할). API 모양을 zod 로 미러.
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  logoUrl: z.string().optional(), // 사이드바/스위처 표시용
})
export type Workspace = z.infer<typeof workspaceSchema>

export const workspacesSchema = z.array(workspaceSchema)

// 컨트롤플레인 GET /workspace(단수) — 활성 워크스페이스 레코드(설정 페이지용). owner 로 삭제 권한을 판단한다.
export const workspaceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  logoUrl: z.string().optional(),
  createdAt: z.string(),
})
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>

export const workspaceUrlBase = 'workspace.assay.io' // 읽기 전용 URL 표시용(slug = id)
