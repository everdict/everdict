import { z } from 'zod'

// 컨트롤플레인 GET /secrets 응답의 클라이언트 미러 — 이름 + 갱신시각만.
// 값은 write-only: 저장 후 절대 반환되지 않는다(서버에서 디스패치 주입 시에만 복호화).
export const secretMetaSchema = z.object({
  name: z.string(),
  updatedAt: z.string(),
})
export type SecretMeta = z.infer<typeof secretMetaSchema>

export const secretsSchema = z.array(secretMetaSchema)
