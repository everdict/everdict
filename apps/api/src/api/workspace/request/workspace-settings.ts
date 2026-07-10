import { JudgeRunConfigSchema } from "@everdict/contracts";
import { z } from "zod";

// Workspace settings patch (partial). Metering on/off + default judge model + completion-notification target.
export const WorkspaceSettingsBodySchema = z.object({
  meterUsage: z.boolean().optional(),
  judge: JudgeRunConfigSchema.optional(), // workspace default judge model (the control plane auto-injects it into the job)
  // run/scorecard completion-notification target (Mattermost connection + channel). A connection-id reference + channel id, not the token/channel values.
  notify: z.object({ connectionId: z.string().min(1), channelId: z.string().min(1) }).optional(),
});
