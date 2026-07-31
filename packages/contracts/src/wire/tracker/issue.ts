import { z } from "zod";
import { ScorecardRecordSchema } from "../../records/scorecard.js";
import { IssueRecordSchema } from "../../records/tracker.js";

// Single-issue response — the IssueRecordSchema IS the SSOT (the tracker keeps no separate read shape; an
// issue's derived data lives on its own endpoints, not inflated into the record).
export const IssueResponseSchema = IssueRecordSchema;
export type IssueResponse = z.infer<typeof IssueResponseSchema>;

export const IssueListResponseSchema = z.array(IssueRecordSchema);
export type IssueListResponse = z.infer<typeof IssueListResponseSchema>;

// GET /issues/:id/scorecards — the issue's EVALUATION HISTORY: the scorecards explicitly linked to it UNION the
// ones derived from its linked datasets/harnesses. Same list shape the scorecard list returns (heavy per-case
// results omitted), so the web renders it with the existing scorecard row components.
export const IssueScorecardsResponseSchema = z.object({
  scorecards: z.array(ScorecardRecordSchema),
  // Which side of the union each row came from, so the UI can distinguish "we pinned this as evidence" from
  // "this ran against a capability the issue watches". Keyed by scorecard id.
  linked: z.array(z.string()),
});
export type IssueScorecardsResponse = z.infer<typeof IssueScorecardsResponseSchema>;
