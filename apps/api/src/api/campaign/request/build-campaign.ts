import { z } from "zod";

// POST /campaigns/:id/builds — build a code-evolution candidate image (docs/architecture/code-evolution-loop.md,
// D2). The commit to build is the caller's (a pull request head, a branch, a tag); WHERE the code lives and HOW
// it builds are frozen on the harness template's `source` + `build` recipe, never sent here — a body that named
// the build steps would be a caller choosing what runs inside Everdict's own image.
export const BuildCampaignBodySchema = z.object({
  ref: z.string().min(1).max(300).describe("What to check out — a pull-request head sha, a branch, or a tag"),
  repo: z.string().min(1).max(200).optional().describe('"owner/name" when the ref is a GitHub pull request'),
  prNumber: z.number().int().positive().optional(),
  slot: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Which slot to rebuild — omit when the template has one buildable slot"),
});
export type BuildCampaignBody = z.infer<typeof BuildCampaignBodySchema>;
