import { z } from "zod";

// Mark-notifications-read request — one of ids or all:true (empty = no-op → read:0).
export const ReadNotificationsBodySchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});
