import { z } from "zod";
import { COMMENT_RESOURCE_TYPES } from "./comment-service.js";

// Create-comment body — target (resourceType/resourceId) + body + optional parentId (reply) + @mention subjects.
export const CreateCommentBodySchema = z.object({
  resourceType: z.enum(COMMENT_RESOURCE_TYPES),
  resourceId: z.string().min(1),
  parentId: z.string().min(1).optional(), // parent comment id if this is a reply (one-level thread)
  body: z.string().min(1),
  mentions: z.array(z.string().min(1)).max(50).optional(), // @mentioned member subjects (filled by the client picker)
});
