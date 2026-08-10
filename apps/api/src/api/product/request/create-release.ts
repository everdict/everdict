import { ReleaseComponentSchema } from "@everdict/contracts";
import { z } from "zod";

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// The shipped composition — one row per tracked service. Bounded by the same 50 the product's service list
// is: a release cannot ship more services than a product may compose.
const Components = z.array(ReleaseComponentSchema).max(50);

export const CreateReleaseBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  targetDate: CalendarDate.optional(),
  // Which of the product's series this release watches. Absent = every series.
  seriesKeys: z.array(z.string().min(1)).max(50).optional(),
  // Which service versions go out together. Absent = the composition was not declared (a different fact
  // from an empty list); a component may name a service without a version while the plan is still open.
  components: Components.optional(),
});
export type CreateReleaseBody = z.infer<typeof CreateReleaseBodySchema>;

export const UpdateReleaseBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  targetDate: CalendarDate.nullable().optional(),
  // `null` clears the selection back to "every series".
  seriesKeys: z.array(z.string().min(1)).max(50).nullable().optional(),
  // `null` clears the declared composition back to "never declared".
  components: Components.nullable().optional(),
});
export type UpdateReleaseBody = z.infer<typeof UpdateReleaseBodySchema>;
