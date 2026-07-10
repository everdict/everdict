import { z } from "zod";

// Comments on a resource (dataset etc.) — collaborative discussion, like Linear issue comments. Flows mixed with events in the activity timeline.
// resourceType is extensible (currently "dataset"). Workspace-scoped + author=author subject.
export const CommentRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  resourceType: z.string(), // "dataset"|"harness"|"scorecard"|"view"|"schedule"|"run"|"runtime"
  resourceId: z.string(),
  parentId: z.string().optional(), // if a reply, the parent comment id (same resource, only top-level can be a parent — one-level thread). Absent = top-level.
  author: z.string(), // author subject
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommentRecord = z.infer<typeof CommentRecordSchema>;
