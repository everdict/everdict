import type { CommentResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED type is anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
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
export const commentsResponseSchema = z.object({ comments: z.array(commentSchema) })

// Drift guard — identical-shape entity (the web models every CommentRecord field and no extra), so the guard
// is bidirectional: a renamed/dropped/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebComment = z.infer<typeof commentSchema>
type _commentFwd = AssertAssignable<WebComment, CommentResponse>
type _commentBack = AssertAssignable<CommentResponse, WebComment>

// Exported name aliases the contract type (consumers untouched: same Comment identifier).
export type Comment = CommentResponse

export type __commentDriftGuard = [_commentFwd, _commentBack]
