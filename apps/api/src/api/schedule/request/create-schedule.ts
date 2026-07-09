import { z } from "zod";
import { ScheduleRunTemplateBodySchema, cronExpr, overlapPolicy } from "./shared.js";

export const CreateScheduleBodySchema = z.object({
  name: z.string().min(1),
  cron: cronExpr,
  timezone: z.string().default("UTC"), // IANA tz (e.g. "Asia/Seoul")
  overlapPolicy: overlapPolicy.default("skip"),
  enabled: z.boolean().default(true),
  runTemplate: ScheduleRunTemplateBodySchema,
});
