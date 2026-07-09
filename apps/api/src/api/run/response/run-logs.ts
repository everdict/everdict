import { RunStatusSchema } from "@everdict/db";
import { z } from "zod";

// GET /runs/:id/logs — snapshot of the case job's current stdout (sentinel-stripped), for poll-and-diff clients.
export const RunLogsResponseSchema = z.object({
  status: RunStatusSchema,
  found: z.boolean().describe("false = nothing to tail yet (queued / GC'd / no backend support)"),
  text: z.string().describe("Current log text (empty string when found=false)"),
});
