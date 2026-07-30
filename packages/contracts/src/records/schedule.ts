import { z } from "zod";

// Scheduled (cron) scorecard — a stored RunScorecardInput + cron expression + policy. Firing reuses ScorecardService.submit.
// This (mutable) store is the SSOT (the UI/API truth); the Temporal Schedule is the execution mechanism (slice 2). Workspace-scoped.
// Design: docs/architecture/scheduled-evals.md.
export const ScheduleOverlapPolicySchema = z.enum(["skip", "bufferOne", "allowAll"]);
export type ScheduleOverlapPolicy = z.infer<typeof ScheduleOverlapPolicySchema>;

// Trace-evaluation fire mode — instead of running dataset×harness, each fire pulls the recent traces from a registered
// observability source (a rolling window ending at the fire moment) and judges them directly (the "evaluate existing
// traces" path — no harness run). This is what powers "every day, judge the last 24h of production traces".
export const SchedulePullConfigSchema = z.object({
  source: z.string().min(1), // a registered workspace trace source name — or the reserved "everdict" (judge the OWNED store's window: N2 continuous evaluation)
  correlate: z.enum(["id", "tag"]).optional(), // fetch-by-trace-id (default for listed ids) vs everdict.run_id tag search
  scope: z.string().min(1).optional(), // platform scope (mlflow experiment / phoenix|langfuse|langsmith project / otel service)
  windowHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30), // rolling lookback ending at each fire (24 = the last day)
});
export type SchedulePullConfig = z.infer<typeof SchedulePullConfigSchema>;

// Report fire mode — instead of running an eval, each fire wakes the workspace agent for ONE headless analysis turn
// over a saved View: it queries the view's lens (query_scorecards), optionally compares against the previous period,
// and emits a report artifact pinned to the view (docs/architecture/analysis-studio.md V4). "Every Monday, report
// this view's pass-rate movement to the team."
export const ScheduleReportConfigSchema = z.object({
  view: z.string().min(1), // the saved View id the report covers (its config is the analysis lens)
  instructions: z.string().min(1).max(4_000).optional(), // standing instructions appended to the report prompt
  compare: z.enum(["previous-period"]).optional(), // also diff against the preceding window of the same length
});
export type ScheduleReportConfig = z.infer<typeof ScheduleReportConfigSchema>;

// The eval definition that flows into the fire path. A schedule runs in ONE of three modes (enforced by the refine):
// batch (dataset×harness → ScorecardService.submit) OR trace evaluation (pull → ScorecardService.ingestPull over a
// rolling window) OR report (report → a headless agent analysis turn over a View). tenant/submittedBy are filled
// from the schedule at fire time.
export const ScheduleRunTemplateSchema = z
  .object({
    // batch mode — optional so a pull-mode schedule omits them.
    dataset: z.object({ id: z.string(), version: z.string() }).optional(),
    harness: z.object({ id: z.string(), version: z.string() }).optional(),
    // trace-evaluation mode — mutually exclusive with dataset/harness.
    pull: SchedulePullConfigSchema.optional(),
    // report mode — mutually exclusive with both eval modes.
    report: ScheduleReportConfigSchema.optional(),
    judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
    runtime: z.string().optional(),
    concurrency: z.number().int().min(1).max(64).optional(),
    // run each case N times for pass@k / flakiness — the same knob as a one-off scorecard (unset = 1). Scheduled
    // regression runs are exactly where flakiness matters, so the schedule must be able to set it. (batch mode only)
    trials: z.number().int().min(1).max(100).optional(),
    // partial run — only a subset of the dataset each fire (cost/smoke). Applied in order: ids → tags → limit. (batch mode only)
    cases: z
      .object({
        ids: z.array(z.string().min(1)).min(1).optional(),
        tags: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(10_000).optional(),
      })
      .optional(),
  })
  .refine(
    (t) =>
      [t.pull !== undefined, t.dataset !== undefined && t.harness !== undefined, t.report !== undefined].filter(Boolean)
        .length === 1,
    {
      message:
        "a schedule runs EXACTLY ONE mode: a dataset×harness batch (dataset+harness), a trace evaluation (pull), or a view report (report)",
    },
  );
export type ScheduleRunTemplate = z.infer<typeof ScheduleRunTemplateSchema>;

export const ScheduleRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  cron: z.string(), // 5-field cron (validated at the boundary). Converted with timezone into a Temporal spec (slice 2).
  timezone: z.string(), // IANA tz (e.g. "Asia/Seoul"). Default "UTC".
  overlapPolicy: ScheduleOverlapPolicySchema,
  enabled: z.boolean(),
  createdBy: z.string(), // creator subject — the fired run's submittedBy (budget → tenant, resolves private-repo connections).
  runTemplate: ScheduleRunTemplateSchema,
  lastFiredAt: z.string().optional(),
  lastStatus: z.string().optional(), // the previous fire's result (scorecard status / "reported" / error reason)
  lastScorecardId: z.string().optional(),
  lastArtifactId: z.string().optional(), // report mode — the previous fire's report artifact (mig 0078)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;
