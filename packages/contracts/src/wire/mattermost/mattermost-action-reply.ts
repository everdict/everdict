import { z } from "zod";

// Mattermost interactive-action (button) reply — Mattermost shows ephemeral_text to the clicking user only.
export const MattermostActionReplySchema = z.object({
  ephemeral_text: z.string(),
});
export type MattermostActionReply = z.infer<typeof MattermostActionReplySchema>;
