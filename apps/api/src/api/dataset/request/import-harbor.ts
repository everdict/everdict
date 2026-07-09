import { HarborTaskSchema } from "@everdict/datasets";
import { z } from "zod";

// Harbor (Anthropic) task-set import → a workspace Dataset (same on-ramp as Terminal-Bench). docs/architecture/standard-task-formats.md
export const ImportHarborBodySchema = z.object({
  dataset: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  tasks: z.array(HarborTaskSchema).min(1),
  imageTemplate: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
