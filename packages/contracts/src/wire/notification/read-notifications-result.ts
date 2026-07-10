import { z } from "zod";

// POST /notifications/read response — how many notifications were newly marked read
// (idempotent: already-read items are left alone and not counted).
export const ReadNotificationsResultResponseSchema = z.object({
  read: z.number().int().describe("Count of notifications newly marked read"),
});
export type ReadNotificationsResultResponse = z.infer<typeof ReadNotificationsResultResponseSchema>;
