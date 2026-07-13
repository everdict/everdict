import { z } from "zod";

// A single leaf change between two resolved harness versions — one field path's before → after (display strings).
// path = dot/bracket path into the resolved HarnessSpec (e.g. "command", "env.MODEL", "services[backend].image").
// change = added (only in candidate) | removed (only in base) | changed (present in both, value differs).
export const HarnessFieldChangeSchema = z.object({
  path: z.string(),
  before: z.string(), // repr of the base value ("(none)" when absent)
  after: z.string(), // repr of the candidate value ("(none)" when absent)
  change: z.enum(["added", "removed", "changed"]),
});
export type HarnessFieldChange = z.infer<typeof HarnessFieldChangeSchema>;

// The structural diff of two harness versions (base ↔ candidate), compared on the RESOLVED spec (template + pins applied).
// Immutable-version premise: the same (id, version) always resolves to the same spec, so the comparison is reproducible.
// kindChanged flags a whole-spec restructure (process ↔ command ↔ service) — the field-level changes are still reported.
export const HarnessSpecDiffSchema = z.object({
  id: z.string(),
  base: z.string(), // resolved base version (e.g. "1.0.0")
  candidate: z.string(), // resolved candidate version
  kindChanged: z.boolean(),
  changes: z.array(HarnessFieldChangeSchema), // sorted by path (stable output)
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
  }),
});
export type HarnessSpecDiff = z.infer<typeof HarnessSpecDiffSchema>;
