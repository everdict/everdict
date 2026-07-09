import { z } from "zod";

// Origin coordinates the submitter attaches (commit/PR/CI run) — origin.source is decided server-side from principal.via (client can't forge it).
export const ScorecardOriginBodySchema = z.object({
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(),
  prNumber: z.number().int().optional(),
  runUrl: z.string().optional(),
});
