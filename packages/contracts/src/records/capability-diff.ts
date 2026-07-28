import { z } from "zod";

// A single leaf change between two capability versions — one field path's before → after (display strings).
// path = dot/bracket path into the compared content object { name, description, spec.* } (e.g. "description",
// "spec.url", "spec.code", "spec.preset.dependencies[postgres].isolateBy").
// change = added (only in candidate) | removed (only in base) | changed (present in both, value differs).
export const CapabilityFieldChangeSchema = z.object({
  path: z.string(),
  before: z.string(), // repr of the base value ("(none)" when absent)
  after: z.string(), // repr of the candidate value ("(none)" when absent)
  change: z.enum(["added", "removed", "changed"]),
});
export type CapabilityFieldChange = z.infer<typeof CapabilityFieldChangeSchema>;

// The structural diff of two capability versions (base ↔ candidate), computed over the IMMUTABLE content
// (name/description/spec) — reach/tags/createdAt are mutable metadata and excluded. Immutable-version premise: the same
// (tenant, id, version) always resolves to the same content, so the comparison is reproducible. typeChanged flags a
// whole-kind restructure (mcp ↔ code ↔ skill ↔ environment) — the field-level changes are still reported. Mirrors
// HarnessSpecDiff (kindChanged) on the shared spec-diff engine.
export const CapabilitySpecDiffSchema = z.object({
  id: z.string(),
  base: z.string(), // resolved base version (e.g. "1.0.0")
  candidate: z.string(), // resolved candidate version
  typeChanged: z.boolean(),
  changes: z.array(CapabilityFieldChangeSchema), // sorted by path (stable output)
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
  }),
});
export type CapabilitySpecDiff = z.infer<typeof CapabilitySpecDiffSchema>;
