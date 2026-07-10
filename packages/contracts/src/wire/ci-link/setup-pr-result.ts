import { z } from "zod";

// POST /workspace/ci/links/setup-pr — the opened (or reused, near-idempotent) setup PR.
export const SetupPrResultSchema = z.object({
  prUrl: z.string().describe("The PR's html URL on GitHub (existing PR when one is already open)"),
  branch: z.string().describe("The branch the workflow file was committed to"),
});
export type SetupPrResult = z.infer<typeof SetupPrResultSchema>;
