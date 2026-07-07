import { z } from 'zod'

// Client mirror of the control plane GET /comments response. Collaborative discussion attached to a resource (dataset, etc.).
export const commentSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  parentId: z.string().optional(), // parent comment id if this is a reply (single-level thread)
  author: z.string(), // author subject
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Comment = z.infer<typeof commentSchema>
export const commentsResponseSchema = z.object({ comments: z.array(commentSchema) })
