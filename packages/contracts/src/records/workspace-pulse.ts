import { z } from "zod";
import type { PlatformEventKind } from "./platform-event.js";

// The workspace PULSE — what a workspace is doing right now, and which way it has been moving.
//
// Everdict's home screen used to answer one question ("what did we evaluate"), which is a true answer to a
// question most people did not arrive with: a workspace also files issues, runs iterations, chases goals, keeps
// agents working and publishes knowledge. The pulse is the whole surface of that, read in ONE call — a
// dashboard that fans out eight list reads is a dashboard that gets slower every time the product grows.
//
// Two halves, deliberately named apart:
//   • the COUNTS are the state right now (open issues, active cycles, pending approvals) — exact, from the
//     aggregates the stores already answer;
//   • the TREND is the recorded past — derived from the platform-event log, which is the only place the
//     workspace's history is written down in one shape. That log has a retention window (EO4 pruning), so the
//     series says what the log holds and never extrapolates past its own edge.

// --- The activity AXIS ---
// Which part of the product a fact belongs to, grouped the way a person reads their workspace rather than by
// which service happened to emit it. Four axes, because a stacked series with more bands than that stops being
// readable — and because these are the four things a workspace here actually does.
export const WORKSPACE_ACTIVITY_AXES = ["work", "evaluation", "agent", "knowledge"] as const;
export const WorkspaceActivityAxisSchema = z.enum(WORKSPACE_ACTIVITY_AXES);
export type WorkspaceActivityAxis = z.infer<typeof WorkspaceActivityAxisSchema>;

// Every kind in the closed vocabulary lands on exactly one axis. `satisfies` is the point: a new event kind
// fails the typecheck here until somebody says which part of the workspace it is news about, so the pulse can
// never silently drop a fact into a chart that does not draw it.
const ACTIVITY_AXIS_BY_KIND = {
  // The tracker — the "why we evaluate" layer, plus the coordination around it.
  "issue.created": "work",
  "issue.status_changed": "work",
  "issue.moved": "work",
  "issue.linked": "work",
  "issue_label.created": "work",
  "issue_label.updated": "work",
  "issue_label.deleted": "work",
  "project.created": "work",
  "project.status_changed": "work",
  "project.update_posted": "work",
  "initiative.created": "work",
  "initiative.status_changed": "work",
  "initiative.update_posted": "work",
  "cycle.created": "work",
  "cycle.completed": "work",
  "team.created": "work",
  "team.member_added": "work",
  "team.member_removed": "work",
  "task.created": "work",
  "task.claimed": "work",
  "task.completed": "work",
  "task.cancelled": "work",
  "comment.created": "work",
  // Evaluation — what ran, what it scored, and the material it ran on.
  "run.submitted": "evaluation",
  "run.completed": "evaluation",
  "run.failed": "evaluation",
  "run.placement_blocked": "evaluation",
  "scorecard.submitted": "evaluation",
  "scorecard.case.completed": "evaluation",
  "scorecard.completed": "evaluation",
  "scorecard.failed": "evaluation",
  "scorecard.cancelled": "evaluation",
  "scorecard.scored": "evaluation",
  "scorecard.moved": "evaluation",
  "report.completed": "evaluation",
  "harness.registered": "evaluation",
  "harness.moved": "evaluation",
  "dataset.registered": "evaluation",
  "dataset.moved": "evaluation",
  "judge.registered": "evaluation",
  "judge.moved": "evaluation",
  "schedule.fired": "evaluation",
  "trace.threshold_crossed": "evaluation",
  "trace.ingestion_throttled": "evaluation",
  "runtime.circuit_opened": "evaluation",
  "budget.exceeded": "evaluation",
  // The agent at work — its runs and the gate a parked mutation waits at.
  "agent.run.started": "agent",
  "agent.run.awaiting_approval": "agent",
  "agent.run.completed": "agent",
  "agent.run.failed": "agent",
  "agent.run.cancelled": "agent",
  "approval.requested": "agent",
  "approval.decided": "agent",
  // What the workspace knows — the files and entries members and agents write.
  "file.published": "knowledge",
  "knowledge.created": "knowledge",
  "knowledge.proposed": "knowledge",
  "knowledge.approved": "knowledge",
} as const satisfies Record<PlatformEventKind, WorkspaceActivityAxis>;

// The axis a recorded fact belongs to. Takes a plain string because the log is read back as data (a kind
// recorded by a newer deployment must not throw in an older reader) — an unknown kind has no axis, and the
// caller drops it rather than guessing.
export function activityAxisOf(kind: string): WorkspaceActivityAxis | undefined {
  return (ACTIVITY_AXIS_BY_KIND as Record<string, WorkspaceActivityAxis>)[kind];
}

// --- The series ---

// One day of recorded activity, split by axis. `total` is carried rather than summed by every reader: the chart
// draws the bands, the tooltip draws the total, and two of them adding differently is not a thing that should
// be possible.
export const WorkspaceActivityPointSchema = z.object({
  date: z.string(), // YYYY-MM-DD, UTC — the same day boundary the usage series uses
  work: z.number().int().nonnegative(),
  evaluation: z.number().int().nonnegative(),
  agent: z.number().int().nonnegative(),
  knowledge: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type WorkspaceActivityPoint = z.infer<typeof WorkspaceActivityPointSchema>;

// One day of issue FLOW — how much work arrived and how much left. The pair is the point: a backlog that grows
// while both numbers are healthy is a different story from one that grows because nothing closes.
export const WorkspaceFlowPointSchema = z.object({
  date: z.string(),
  created: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
});
export type WorkspaceFlowPoint = z.infer<typeof WorkspaceFlowPointSchema>;

// One day of evaluated quality. `passRate` is ABSENT on a day whose batches reported none — a missing
// measurement is not a zero, and drawing it as one is how a dashboard invents a cliff.
export const WorkspaceQualityPointSchema = z.object({
  date: z.string(),
  scorecards: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1).optional(),
});
export type WorkspaceQualityPoint = z.infer<typeof WorkspaceQualityPointSchema>;

// --- The whole reading ---

export const WorkspacePulseSchema = z.object({
  // What the trend covers. `days` is what the caller asked for; `from`/`to` are the instants it resolved to.
  window: z.object({ from: z.string(), to: z.string(), days: z.number().int().positive() }),
  // The tracker's state right now — exact counts, not a sample.
  work: z.object({
    open: z.number().int().nonnegative(), // everything not done/cancelled, `regressed` included
    inProgress: z.number().int().nonnegative(),
    regressed: z.number().int().nonnegative(), // a resolution that stopped holding — the alarm
  }),
  // The iterations that are running, and how much of what they committed to is finished.
  cycles: z.object({
    active: z.number().int().nonnegative(),
    committed: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    endingSoon: z.number().int().nonnegative(), // closing within a week — what a planning conversation is about
  }),
  // What the workspace is trying to achieve, and how much of it somebody has flagged.
  goals: z.object({
    initiatives: z.number().int().nonnegative(), // active goals
    projects: z.number().int().nonnegative(), // projects in flight (planned or started)
    atRisk: z.number().int().nonnegative(), // goals + projects whose posted health is at_risk or off_track
  }),
  // The other kind of worker in the workspace.
  agents: z.object({
    runs: z.number().int().nonnegative(), // agent runs that finished inside the window
    openTasks: z.number().int().nonnegative(), // the shared task ledger's unfinished work
    awaitingApproval: z.number().int().nonnegative(), // parked mutations waiting on a human decision
  }),
  // The eval half — kept, but as ONE of the things a workspace does rather than the whole screen.
  evaluation: z.object({
    scorecards: z.number().int().nonnegative(), // batches completed inside the window
    runs: z.number().int().nonnegative(), // executions that finished inside the window
    failed: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1).optional(), // mean over the window's batches; absent when none reported one
    passRateBefore: z.number().min(0).max(1).optional(), // the SAME mean over the preceding window — the delta's other half
  }),
  trend: z.object({
    activity: z.array(WorkspaceActivityPointSchema),
    flow: z.array(WorkspaceFlowPointSchema),
    quality: z.array(WorkspaceQualityPointSchema),
  }),
});
export type WorkspacePulse = z.infer<typeof WorkspacePulseSchema>;
