import { IssueStatusSchema, WorkflowStateColorSchema } from "@everdict/contracts";
import { z } from "zod";

// The workspace's named workflow state. `status` is the CANONICAL vocabulary the state is a view onto — that is what
// keeps a rename from ever reaching the release gate. `regressed` is refused: an issue reaches it by a
// resolution falling, never by somebody dragging a card.
export const CreateWorkflowStateBodySchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  status: IssueStatusSchema.exclude(["regressed"]),
  color: WorkflowStateColorSchema,
});

export const UpdateWorkflowStateBodySchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    description: z.string().max(500).nullable().optional(),
    status: IssueStatusSchema.exclude(["regressed"]).optional(),
    color: WorkflowStateColorSchema.optional(),
    // Board order. Re-mapping `status` MOVES every issue in the column, which is why it is an explicit edit.
    position: z.number().int().nonnegative().max(100).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");
