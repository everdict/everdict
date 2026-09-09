import { z } from "zod";

// ── WHAT A MEASUREMENT IS, AS COORDINATES RATHER THAN AS A LABEL ────────────────────────────────────
//
// Who produced it, which metric it is, and — for a judge — which criterion. Policy matching and structured
// deduplication consume these fields; only the collection adapter ever derives them from a display name.
//
// ⚠️ IT LIVES IN ITS OWN MODULE BECAUSE BOTH SIDES OF THE COLLECTION BOUNDARY NEED IT. `grader.ts` builds the
// identity (`measurementIdentityOf`) and `verdict-policy.ts` reads it (`isJudgeMetricOf`, `MetricDefinition`),
// so declaring it in either one makes the two import each other — and a cycle survives only while every use
// is deferred to call time, which is not a property anybody can keep true by intention. The value both sides
// need belongs to neither of them, so it is here, importing from neither (rule `ci`, `pnpm import-cycles`).
//
// This module imports zod and nothing else. Keep it that way: anything added here that reaches back into the
// score or policy vocabulary re-creates the cycle it exists to remove.
export const MeasurementIdentitySchema = z.object({
  producer: z.object({ kind: z.enum(["grader", "judge"]), id: z.string().min(1) }),
  metric: z.string().min(1),
  criterion: z.string().min(1).optional(),
});
export type MeasurementIdentity = z.infer<typeof MeasurementIdentitySchema>;
