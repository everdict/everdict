import { ReleaseStatusSchema } from "@everdict/contracts";
import { z } from "zod";

export const SetReleaseStatusBodySchema = z.object({
  status: ReleaseStatusSchema,
  // Releasing over open issues or a regressed series is refused unless the caller says so explicitly. The
  // override is recorded on the fact and in the history, so a forced ship never reads as a clean one later.
  force: z.boolean().optional(),
});
export type SetReleaseStatusBody = z.infer<typeof SetReleaseStatusBodySchema>;
