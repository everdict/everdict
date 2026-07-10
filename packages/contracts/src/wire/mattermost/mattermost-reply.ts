import { z } from "zod";

// Mattermost slash-command reply (MattermostCommandService.MattermostReply) — rendered by Mattermost itself.
// response_type in_channel is visible to everyone in the channel; ephemeral only to the caller.
export const MattermostReplySchema = z.object({
  response_type: z.enum(["ephemeral", "in_channel"]),
  text: z.string().describe("Markdown message Mattermost renders"),
});
export type MattermostReply = z.infer<typeof MattermostReplySchema>;
