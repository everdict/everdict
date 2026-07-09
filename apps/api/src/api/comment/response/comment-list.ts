import { CommentRecordSchema } from "@everdict/db";
import { z } from "zod";

// GET /comments response — one resource's thread wrapped in { comments }, oldest first (timeline order).
export const CommentListResponseSchema = z.object({
  comments: z.array(CommentRecordSchema).describe("Oldest first (createdAt ascending) — timeline order"),
});
