import { z } from 'zod'

// 업로드 라우트(`POST /api/fs/uploads`)의 답. 우리 BFF 가 주는 것이지만 경계는 경계라 파싱해서 받는다.
export const uploadedMediaSchema = z.object({
  path: z.string(),
  url: z.string(),
  name: z.string(),
  kind: z.enum(['image', 'video', 'audio']).optional(), // 매체가 아닌 파일은 종류 없이 링크로 붙는다
})
export type UploadedMedia = z.infer<typeof uploadedMediaSchema>
