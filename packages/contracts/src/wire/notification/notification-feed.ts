import { z } from "zod";
import { NotificationRecordSchema } from "../../records/notification.js";

// GET /notifications response — the personal bell-inbox feed, wrapped in { notifications }.
// NotificationRecordSchema (records/notification.ts, in this package) IS the SSOT for each item.
export const NotificationFeedResponseSchema = z.object({
  notifications: z.array(NotificationRecordSchema).describe("Newest first; default 50, capped at 200 via ?limit"),
});
export type NotificationFeedResponse = z.infer<typeof NotificationFeedResponseSchema>;
