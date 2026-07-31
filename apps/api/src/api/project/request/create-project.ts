import { z } from "zod";

// Calendar dates, not instants: "did we finish the evaluation by the 14th" is a date question, and the literal
// YYYY-MM-DD round-trips with no timezone reinterpretation on either side of the wire.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// A project is created `planned` and moves through POST /projects/:id/status — the status is never an argument
// here, so completing one always passes the open-issue gate.
export const CreateProjectBodySchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  // A pointer to the initiative umbrella, unvalidated like an issue link — the initiative's readiness read
  // resolves it, and a dangling id costs a project no correctness.
  initiativeId: z.string().min(1).max(200).optional(),
  targetDate: CalendarDateSchema.optional(),
});
