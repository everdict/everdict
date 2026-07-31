import { z } from "zod";
import { ProjectRecordSchema, ProjectRollupSchema } from "../../records/tracker.js";

export const ProjectResponseSchema = ProjectRecordSchema;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const ProjectListResponseSchema = z.array(ProjectRecordSchema);
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

// GET /projects/:id — the record plus its issue rollup. Derived on read (the ScorecardRecord.trialSummary
// precedent): counting issues is always-fresh arithmetic, where a stored rollup would be a cache to invalidate
// on every child write. Lists stay lean and carry no rollup.
export const ProjectDetailResponseSchema = ProjectRecordSchema.extend({
  rollup: ProjectRollupSchema,
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;
