import { z } from 'zod'

// Client mirror of the control-plane "saved scorecard-analysis View". The web is coupled over HTTP only — no @everdict/* dependency.
// config is the web AnalysisConfig (recipe) — opaque here (the web validates its shape). Not a snapshot: re-runs on current data when opened (live).
export const viewVisibilitySchema = z.enum(['private', 'workspace'])
export type ViewVisibility = z.infer<typeof viewVisibilitySchema>

export const viewSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  config: z.unknown(), // web AnalysisConfig — corresponds to paramsToConfig (opaque storage).
  visibility: viewVisibilitySchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type View = z.infer<typeof viewSchema>
export const viewsSchema = z.array(viewSchema)
