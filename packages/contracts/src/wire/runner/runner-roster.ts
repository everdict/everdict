import { z } from "zod";
import { RunnerMetaSchema } from "./runner-meta.js";

// Runner list responses (personal list, workspace roster, workspace-owned list) — metadata only, no tokens.
export const RunnerRosterSchema = z.object({
  runners: z.array(RunnerMetaSchema),
});
export type RunnerRoster = z.infer<typeof RunnerRosterSchema>;
