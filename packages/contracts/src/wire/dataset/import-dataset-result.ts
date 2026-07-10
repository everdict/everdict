import { z } from "zod";

// POST /datasets/terminal-bench · /datasets/harbor 201 — registered coordinates + mapped case count.
export const ImportDatasetResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  cases: z.number().int().describe("Number of eval cases mapped from the task set"),
});
