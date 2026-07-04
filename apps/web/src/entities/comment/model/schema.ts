import { z } from 'zod'

// 컨트롤플레인 GET /comments 응답의 클라이언트 미러. 리소스(데이터셋 등)에 달린 협업 논의.
export const commentSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  parentId: z.string().optional(), // 대댓글이면 부모 댓글 id(1단계 스레드)
  author: z.string(), // 작성자 subject
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Comment = z.infer<typeof commentSchema>
export const commentsResponseSchema = z.object({ comments: z.array(commentSchema) })
