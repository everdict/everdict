import { z } from "zod";

// Calendar dates, not instants: a release date is a date, and the literal YYYY-MM-DD round-trips with no
// timezone reinterpretation on either side of the wire.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// An initiative is created `active` — completion is the release gate and only reachable through
// POST /initiatives/:id/status, which reads live readiness first.
export const CreateInitiativeBodySchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  // The initiative this one sits under. Readiness rolls UP through the tree, so a parent answers for every
  // descendant's projects — which is what makes decomposing a big bet safe for the release gate.
  parentId: z.string().min(1).max(200).optional(),
  targetDate: CalendarDateSchema.optional(),
});
