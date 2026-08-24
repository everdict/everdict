import type { AnalysisDimension } from "@everdict/domain";
import { z } from "zod";

// POST /scorecards/query — the flexible analysis pivot (docs/architecture/analysis-studio.md V1).
// Strict enums: a bad value is 400 at this boundary (stored View recipes normalize at open instead, web-side).
// Boundary defaults make the parsed body a complete @everdict/domain AnalysisConfig.

// Compile-time drift guard — the DTO's dimension list and the domain union must stay identical.
type AssertAssignable<A extends B, B> = A;
const DIMENSIONS = [
  "dataset",
  "datasetVersion",
  "harness",
  "harnessVersion",
  "model",
  "judgeModel",
  "status",
  "originSource",
  "repo",
  "owner",
  "day",
  "week",
  "month",
] as const;
// EXPORTED so `noUnusedLocals` and this guard can coexist (arch-review 65). The pair exists only to break
// the build when the two lists diverge, and an unexported type alias reads to the compiler as dead — which is
// exactly what the check is for everywhere else. Naming the invariant on the module surface says what it is.
export type AnalysisDimensionDriftGuard = [
  AssertAssignable<(typeof DIMENSIONS)[number], AnalysisDimension>,
  AssertAssignable<AnalysisDimension, (typeof DIMENSIONS)[number]>,
];

export const AnalysisDimensionSchema = z.enum(DIMENSIONS);

export const AnalysisQueryBodySchema = z.object({
  filters: z
    .object({
      dataset: z.array(z.string()).optional(),
      harness: z.array(z.string()).optional(),
      model: z.array(z.string()).optional(),
      judgeModel: z.array(z.string()).optional(),
      status: z.array(z.string()).optional(),
      owner: z.array(z.string()).optional(),
      originSource: z.array(z.string()).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .default({}),
  groupBy: z.array(AnalysisDimensionSchema).max(2).default(["harness"]),
  pivotBy: AnalysisDimensionSchema.optional(),
  metric: z.string().optional(),
  measure: z.enum(["passRate", "mean", "count", "latest"]).default("passRate"),
  sort: z
    .object({
      by: z.enum(["measure", "label"]).default("measure"),
      dir: z.enum(["asc", "desc"]).default("desc"),
    })
    .default({ by: "measure", dir: "desc" }),
  search: z.string().optional(),
  viz: z.enum(["table", "bars", "line"]).default("table"),
  includeIncomplete: z.boolean().optional(),
});
export type AnalysisQueryBody = z.infer<typeof AnalysisQueryBodySchema>;
