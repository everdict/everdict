import { z } from "zod";

// Saved scorecard-analysis "View" — save the web AnalysisConfig (filter·group·measure·search config) under a name and
// share it in the workspace. Not a snapshot, only the config (recipe) — re-runs with current data when opened (live).
// config is opaque jsonb to the control plane (the web validates its shape). Design: docs/architecture/scorecard-analysis-views.md.
export const ViewVisibilitySchema = z.enum(["private", "workspace"]);
export type ViewVisibility = z.infer<typeof ViewVisibilitySchema>;

export const ViewRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  config: z.unknown(), // the web AnalysisConfig — opaque here (jsonb).
  visibility: ViewVisibilitySchema,
  createdBy: z.string(), // owner subject
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ViewRecord = z.infer<typeof ViewRecordSchema>;
