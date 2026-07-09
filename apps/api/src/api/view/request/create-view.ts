import { z } from "zod";
import { ViewVisibilityBody } from "./shared.js";

export const CreateViewBodySchema = z.object({
  name: z.string().min(1),
  config: z.unknown(), // web AnalysisConfig (recipe). The control plane does not enforce its shape.
  visibility: ViewVisibilityBody.default("private"),
});
