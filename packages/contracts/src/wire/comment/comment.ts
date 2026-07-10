import type { z } from "zod";
import { CommentRecordSchema } from "../../records/comment.js";

// Single-comment response — the @everdict/db CommentRecordSchema IS the SSOT
// (id/tenant/resourceType/resourceId/parentId?/author/body/createdAt/updatedAt).
export const CommentResponseSchema = CommentRecordSchema;
export type CommentResponse = z.infer<typeof CommentResponseSchema>;
