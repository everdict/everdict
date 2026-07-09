import { z } from "zod";

// Saved scorecard-analysis View — a named AnalysisConfig (opaque config: the web validates its shape) + visibility (private|workspace).
const ViewVisibilityBody = z.enum(["private", "workspace"]);
export const CreateViewBodySchema = z.object({
  name: z.string().min(1),
  config: z.unknown(), // web AnalysisConfig (recipe). The control plane does not enforce its shape.
  visibility: ViewVisibilityBody.default("private"),
});
export const UpdateViewBodySchema = z.object({
  name: z.string().min(1).optional(),
  config: z.unknown().optional(),
  visibility: ViewVisibilityBody.optional(),
});
