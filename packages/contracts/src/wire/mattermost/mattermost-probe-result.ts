import { z } from "zod";

// POST /workspace/mattermost/probe 200 — connection-test outcome for a Mattermost bot token (+ optional channel),
// run BEFORE registration. Mirrors the trace-source/sink probe convention: a classified failure (reason set,
// reachable=false) is still a 200 — the web renders the reason and gates Save on reachable=true. No secrets echoed.
export const MattermostProbeResultSchema = z.object({
  reachable: z.boolean().describe("true = the bot token authenticated and (if given) the channel is accessible"),
  detail: z.string().describe("Human-readable probe detail"),
  reason: z
    .enum(["auth", "channel", "unreachable", "error"])
    .optional()
    .describe(
      "Structured failure class — auth=token rejected · channel=channel not found/forbidden · absent when reachable",
    ),
  botUsername: z.string().optional().describe("The bot user's username (from /users/me) — present when reachable"),
  channelName: z
    .string()
    .optional()
    .describe("The verified channel's display name — present when a channel was checked"),
});
export type MattermostProbeResult = z.infer<typeof MattermostProbeResultSchema>;
