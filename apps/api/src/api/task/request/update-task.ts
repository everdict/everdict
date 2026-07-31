import { AgentTaskStatusSchema } from "@everdict/contracts";
import { z } from "zod";

export const UpdateTaskBodySchema = z
  .object({
    subject: z.string().min(1).max(300).optional(),
    description: z.string().max(10_000).optional(),
    status: AgentTaskStatusSchema.optional(),
    owner: z.string().min(1).max(200).optional(),
    blockedBy: z.array(z.string().min(1)).max(20).optional(),
  })
  .refine(
    (b) =>
      b.subject !== undefined ||
      b.description !== undefined ||
      b.status !== undefined ||
      b.owner !== undefined ||
      b.blockedBy !== undefined,
    { message: "Nothing to update." },
  );
