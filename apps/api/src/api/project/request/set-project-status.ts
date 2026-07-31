import { ProjectStatusSchema } from "@everdict/contracts";
import { z } from "zod";

// One endpoint for every workflow move; the domain decides which transitions are legal from the current state.
export const SetProjectStatusBodySchema = z.object({
  status: ProjectStatusSchema,
  // Completing a project with open issues is refused unless the caller says so explicitly. The override is
  // recorded on the fact and in the history, so a forced completion never reads as a met deadline later.
  force: z.boolean().optional(),
});
