import { z } from 'zod'

// 컨트롤플레인 GET /secrets 응답의 클라이언트 미러 — 이름 + 갱신시각 + 스코프.
// scope: "workspace"(공유, admin 관리) | "user"(내 개인, 셀프 관리). 값은 write-only(저장 후 반환 안 됨).
export const secretScopeSchema = z.enum(['user', 'workspace'])
export type SecretScope = z.infer<typeof secretScopeSchema>

export const secretMetaSchema = z.object({
  name: z.string(),
  updatedAt: z.string(),
  scope: secretScopeSchema.default('workspace'),
})
export type SecretMeta = z.infer<typeof secretMetaSchema>

export const secretsSchema = z.array(secretMetaSchema)
