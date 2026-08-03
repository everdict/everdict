import { z } from "zod";

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// Content editing only — status moves go through POST /initiatives/:id/status so the completion gate can never
// be crossed by a rename. `null` clears an optional field (including `parentId`, which detaches it back to the
// top level). Projects join an initiative from the project side (PATCH /projects/:id with initiativeIds), so
// membership is not editable here.
export const UpdateInitiativeBodySchema = z
  .object({
    name: z.string().min(1).max(300).optional(),
    description: z.string().max(50_000).nullable().optional(),
    parentId: z.string().min(1).max(200).nullable().optional(),
    lead: z.string().min(1).max(200).nullable().optional(),
    targetDate: CalendarDateSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");
