import { z } from "zod";
import { ScheduleRunTemplateBodySchema, cronExpr, overlapPolicy } from "./shared.js";

export const UpdateScheduleBodySchema = z.object({
  name: z.string().min(1).optional(),
  cron: cronExpr.optional(),
  timezone: z.string().optional(),
  overlapPolicy: overlapPolicy.optional(),
  enabled: z.boolean().optional(), // pause/resume
  runTemplate: ScheduleRunTemplateBodySchema.optional(),
});
