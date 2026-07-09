import { CommentRecordSchema } from "@everdict/db";

// Single-comment response — the @everdict/db CommentRecordSchema IS the SSOT
// (id/tenant/resourceType/resourceId/parentId?/author/body/createdAt/updatedAt).
export const CommentResponseSchema = CommentRecordSchema;
