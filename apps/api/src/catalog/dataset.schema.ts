import { HarborTaskSchema, TerminalBenchTaskSchema } from "@everdict/datasets";
import { z } from "zod";

// Terminal-Bench task-set import → a workspace Dataset (standard task-format on-ramp). The client parses task.yaml/git
// into structured tasks (YAML is a boundary concern); this maps + registers them. docs/architecture/standard-task-formats.md
export const ImportTerminalBenchBodySchema = z.object({
  dataset: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  tasks: z.array(TerminalBenchTaskSchema).min(1),
  imageTemplate: z.string().optional(), // resolves a task's image via {id} when the task carries none
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// Harbor (Anthropic) task-set import → a workspace Dataset (same on-ramp as Terminal-Bench). docs/architecture/standard-task-formats.md
export const ImportHarborBodySchema = z.object({
  dataset: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  tasks: z.array(HarborTaskSchema).min(1),
  imageTemplate: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
