import { z } from "zod";
import { CommentRecordSchema } from "../../records/comment.js";

// GET /comments response — one resource's thread wrapped in { comments }, oldest first (timeline order).
export const CommentListResponseSchema = z.object({
  comments: z.array(CommentRecordSchema).describe("Oldest first (createdAt ascending) — timeline order"),
});
export type CommentListResponse = z.infer<typeof CommentListResponseSchema>;
