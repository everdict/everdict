import { z } from "zod";
import { ScheduleResponseSchema } from "./schedule.js";

// GET /schedules — the workspace's schedules, each with best-effort next fire times.
export const ScheduleListResponseSchema = z.array(ScheduleResponseSchema);
