import { z } from "zod";

// POST /campaigns/:id/builds — build a code-evolution candidate image (docs/architecture/code-evolution-loop.md,
// D2). The commit to build is the caller's (a pull request head, a branch, a tag); WHERE the code lives and HOW
// it builds are frozen on the harness template's `source` + `build` recipe, never sent here — a body that named
// the build steps would be a caller choosing what runs inside Everdict's own image.
export const BuildCampaignBodySchema = z
  .object({
    ref: z.string().min(1).max(300).describe("What to check out — a pull-request head sha, a branch, or a tag"),
    repo: z.string().min(1).max(200).optional().describe('"owner/name" when the ref is a GitHub pull request'),
    prNumber: z.number().int().positive().optional(),
    slot: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Which slot to rebuild — omit when the template has one buildable slot"),
    // A BUILD SET (docs/architecture/evolution-routing-spec.md §4): several slots of the same pull request head,
    // minted as ONE candidate version. Exclusive with `slot`.
    slots: z
      .array(z.string().min(1).max(200))
      .min(2)
      .max(32)
      .optional()
      .describe("Two or more slots to rebuild from the same head as one build set — one version carries every pin"),
  })
  .superRefine((body, ctx) => {
    if (body.slots !== undefined && body.slot !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name `slots` for a build set, or `slot` for one build — not both",
      });
  });
export type BuildCampaignBody = z.infer<typeof BuildCampaignBodySchema>;
