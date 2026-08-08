import { z } from "zod";

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const CreateReleaseBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  targetDate: CalendarDate.optional(),
  // Which of the product's series this release watches. Absent = every series.
  seriesKeys: z.array(z.string().min(1)).max(50).optional(),
});
export type CreateReleaseBody = z.infer<typeof CreateReleaseBodySchema>;

export const UpdateReleaseBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  targetDate: CalendarDate.nullable().optional(),
  // `null` clears the selection back to "every series".
  seriesKeys: z.array(z.string().min(1)).max(50).nullable().optional(),
});
export type UpdateReleaseBody = z.infer<typeof UpdateReleaseBodySchema>;
