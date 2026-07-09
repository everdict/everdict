import { z } from "zod";
import { ViewVisibilityBody } from "./shared.js";

export const UpdateViewBodySchema = z.object({
  name: z.string().min(1).optional(),
  config: z.unknown().optional(),
  visibility: ViewVisibilityBody.optional(),
});
