import { z } from "zod";

// GET /campaigns?subjectType=&subjectId= — one capability's evolution memory (evolution-routing-spec.md §5):
// every campaign ever opened on it. Both fields or neither; a half-named subject is refused, never read as
// "everything". Parsed to the store's `CampaignSubjectRef` or `undefined`.
export const CampaignSubjectQuerySchema = z
  .object({
    subjectType: z.enum(["agent", "harness"]).optional(),
    subjectId: z.string().min(1).max(200).optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.subjectType === undefined) !== (q.subjectId === undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subjectType and subjectId go together — name both to read one capability's campaigns, or neither",
      });
  })
  .transform((q) =>
    q.subjectType !== undefined && q.subjectId !== undefined ? { type: q.subjectType, id: q.subjectId } : undefined,
  );
