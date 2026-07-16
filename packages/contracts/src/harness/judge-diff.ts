import { z } from "zod";

// A single leaf change between two judge versions — one field path's before → after (display strings).
// path = dot/bracket path into the JudgeSpec (e.g. "model", "provider", "rubric", "passThreshold", "criteria").
// change = added (only in candidate) | removed (only in base) | changed (present in both, value differs).
export const JudgeFieldChangeSchema = z.object({
  path: z.string(),
  before: z.string(), // repr of the base value ("(none)" when absent)
  after: z.string(), // repr of the candidate value ("(none)" when absent)
  change: z.enum(["added", "removed", "changed"]),
});
export type JudgeFieldChange = z.infer<typeof JudgeFieldChangeSchema>;

// The structural diff of two judge versions (base ↔ candidate). Judges are immutable per (id, version), so the same
// pair always diffs the same way (reproducible). kindChanged flags a model↔harness restructure — the field-level
// changes are still reported so the list reads in context.
export const JudgeSpecDiffSchema = z.object({
  id: z.string(),
  base: z.string(), // base version (e.g. "1.0.0")
  candidate: z.string(), // candidate version
  kindChanged: z.boolean(),
  changes: z.array(JudgeFieldChangeSchema), // sorted by path (stable output)
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
  }),
});
export type JudgeSpecDiff = z.infer<typeof JudgeSpecDiffSchema>;
