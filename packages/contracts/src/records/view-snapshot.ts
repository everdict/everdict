import { z } from "zod";
import { ScorecardAnalysisResponseSchema } from "../wire/scorecard/scorecard-analysis.js";

// A View captured at a moment in time, written to the workspace filesystem under `views/<viewId>/`.
//
// A View is a RECIPE — it re-runs against current data every time it is opened, which is what makes a saved
// lens useful and also means it remembers nothing. A snapshot is the other half: the numbers exactly as they
// read when someone (or a schedule) looked. They accumulate as ordinary files, so the whole history is
// listable/readable through the surfaces that already exist — the Files tree, the shell, and an agent's
// `list_files`/`get_file` — with no new read API and no new store.
//
// `config` travels WITH the result: a View's config can be edited afterwards, and a snapshot whose numbers
// no longer say how they were produced is not evidence. Design: docs/architecture/scorecard-analysis-views.md.

export const ViewSnapshotSchema = z.object({
  viewId: z.string(),
  viewName: z.string(),
  capturedAt: z.string().describe("ISO instant the analysis was computed"),
  capturedBy: z
    .string()
    .describe("Subject that captured it — a member, or the schedule creator on an automatic capture"),
  trigger: z.enum(["manual", "schedule"]).describe("What caused the capture"),
  scheduleId: z.string().optional().describe("Set when trigger is 'schedule'"),
  config: z.unknown().describe("The AnalysisConfig the result was computed from (opaque to the control plane)"),
  result: ScorecardAnalysisResponseSchema.describe("The computed analysis — the grid or line the View rendered"),
  totals: z
    .object({
      scorecards: z.number().int().describe("Scorecards that passed the filters"),
      cases: z.number().int().describe("Scored cases behind the numbers — the sample size of the whole snapshot"),
    })
    .describe("Sample size of the capture, so a later reader can weigh it without re-deriving"),
});
export type ViewSnapshot = z.infer<typeof ViewSnapshotSchema>;
