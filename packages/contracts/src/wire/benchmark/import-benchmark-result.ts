import { z } from "zod";

// POST /benchmarks/import 201 — the registered dataset's coordinates + imported case count.
export const ImportBenchmarkResultSchema = z.object({
  workspace: z.string(),
  id: z.string().describe("The registered dataset id"),
  version: z.string(),
  cases: z.number().int().describe("Number of imported eval cases"),
});
export type ImportBenchmarkResult = z.infer<typeof ImportBenchmarkResultSchema>;
