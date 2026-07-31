import { z } from "zod";

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// Content editing only — status moves go through POST /initiatives/:id/status so the release gate can never be
// crossed by a rename. `null` clears an optional field. Projects join an initiative from the project side
// (PATCH /projects/:id with initiativeId), so membership is not editable here.
export const UpdateInitiativeBodySchema = z
  .object({
    name: z.string().min(1).max(300).optional(),
    description: z.string().max(50_000).nullable().optional(),
    targetDate: CalendarDateSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");
