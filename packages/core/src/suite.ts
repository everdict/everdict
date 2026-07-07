import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";

// Suite: a bundle of cases to run against one harness (id). The version is specified at run time (compare across versions with the same suite).
export const SuiteSchema = z.object({
  id: z.string(),
  harness: z.object({ id: z.string() }),
  cases: z.array(EvalCaseSchema),
});
export type Suite = z.infer<typeof SuiteSchema>;
