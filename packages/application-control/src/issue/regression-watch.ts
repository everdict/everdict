import type { IssueRecord, NotificationRecord, ScorecardRecord } from "@everdict/contracts";
import { resolvePolicyResolution, scorecardPassRate } from "@everdict/domain";
import type { PlatformEventConsumer } from "../platform-event/event-consumer-runner.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { NotificationStore } from "../ports/notification-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { ExecutionPlan } from "../scorecard/execution-plan.js";
import type { IssueService } from "./issue-service.js";

// The REGRESSION WATCH (docs/tracker.md): a resolved issue whose evaluation later degraded reopens itself as
// `regressed`. This is the tracker's reason to exist — nobody is watching a closed issue, so the closed issue
// has to come find them.
//
// It reacts to scorecard.completed through the durable-cursor consumer (E1), which gives at-least-once delivery;
// idempotency is structural rather than bookkept: the candidate filter only matches `done` issues, so a
// redelivery finds the issue already `regressed` and does nothing.
//
// Facts, not judgments: "regressed" here means one number is lower than another number over the same dataset
// and harness. It does not claim the harness got worse, or that the case is flaky — an agent woken by the fact
// does that reasoning.

// The actor stamped on an automatic transition. Not a member and not an agent, so it deliberately does NOT use
// the `agent:<id>:<conv>` causedBy shape — that prefix is the agent loop guard's key and must stay honest.
export const REGRESSION_WATCH_ACTOR = "everdict:regression-watch";

export interface RegressionWatchDeps {
  issues: IssueStore;
  // Transitions go through the service so the reopen emits the same facts a member's reopen would (and, on a
  // push-enabled GitHub copy, reopens the remote issue with the regression explanation).
  issueService: IssueService;
  scorecards: ScorecardStore;
  // The bell feed. Written here rather than in a feed consumer because this is the only place that knows WHO
  // cares about the issue (its creator and assignee); the status fact alone does not carry them.
  feed?: NotificationStore;
}

// The batch's pass rate under ITS OWN stamped policy. A stamp whose document cannot be restored yields no
// rate at all: reopening someone's issue on a number re-derived under today's ladder is a false alarm with a
// name attached to it.
function passRateOf(record: ScorecardRecord): number | undefined {
  if (!record.scorecard) return undefined;
  const resolution = resolvePolicyResolution(record.verdictPolicy, ExecutionPlan.of(record).verdictPolicy);
  if (resolution.status === "unresolvable") return undefined;
  const { total, rate } = scorecardPassRate(record.scorecard, resolution.policy);
  return total > 0 ? rate : undefined;
}

function recipientsOf(issue: IssueRecord): string[] {
  return [...new Set([issue.createdBy, ...(issue.assignee !== undefined ? [issue.assignee] : [])])];
}

export function regressionWatch(deps: RegressionWatchDeps): PlatformEventConsumer {
  return {
    name: "tracker:regression-watch",
    kinds: ["scorecard.completed"],
    async handle(event) {
      const candidate = await deps.scorecards.get(event.subject.id);
      if (!candidate || candidate.tenant !== event.tenant || candidate.status !== "succeeded") return;
      // A partial run (explicit subset of the dataset) never reopens an issue — a 2-case rerun's rate is not
      // the guarantee's rate, and reopening on it is exactly the false alarm that erodes trust in the watch.
      if (candidate.subset) return;
      // A live/failed scoring pass = the plane is between revisions (or broken) — reopening someone's issue
      // on a half-applied re-score is a state mutation over a plane no revision owns. The watch DEFERS: the
      // settle emits its own scorecard.scored fact, and the next completion sweep re-reads a settled plane.
      if ((candidate.scoringPass ?? undefined) !== undefined) return;
      const candidateRate = passRateOf(candidate);
      if (candidateRate === undefined) return; // nothing gradeable to compare

      // Issues that watch this dataset AND this harness, id-level: a cross-VERSION drop is exactly the signal
      // (the harness moved, the issue's guarantee did not).
      const watching = await deps.issues.list(event.tenant, {
        status: "done",
        link: { type: "dataset", id: candidate.dataset.id },
      });
      for (const issue of watching) {
        if (!issue.links.some((link) => link.type === "harness" && link.id === candidate.harness.id)) continue;
        const baselineId = issue.resolution?.scorecardId;
        if (baselineId === undefined || baselineId === candidate.id) continue; // no evidence, or this IS the baseline

        const baseline = await deps.scorecards.get(baselineId);
        if (!baseline || baseline.tenant !== event.tenant) continue;
        // The BASELINE side too — the closing scorecard can itself be mid-rescore (both sides are live planes).
        if ((baseline.scoringPass ?? undefined) !== undefined) continue;
        // A late-arriving OLD batch must not look like a regression — only a run after the resolution counts.
        if (candidate.createdAt <= baseline.createdAt) continue;
        // Cross-HARNESS-version drops are the signal (the harness moved, the guarantee did not) — but a
        // different DATASET version is a different case set: the comparison does not hold, so it cannot reopen.
        if (candidate.dataset.version !== baseline.dataset.version) continue;
        const baselineRate = passRateOf(baseline);
        if (baselineRate === undefined || candidateRate >= baselineRate) continue;

        const note =
          `Pass rate fell from ${Math.round(baselineRate * 100)}% to ${Math.round(candidateRate * 100)}% ` +
          `on ${candidate.dataset.id} × ${candidate.harness.id}@${candidate.harness.version}.`;
        const regressed = await deps.issueService.setStatus(
          event.tenant,
          issue.id,
          { status: "regressed", cause: "regression", resolution: { scorecardId: candidate.id, note } },
          { subject: REGRESSION_WATCH_ACTOR },
        );

        // Idempotent by the natural key, like every other feed row — a cursor rewind writes no duplicates.
        for (const [index, recipient] of recipientsOf(regressed).entries()) {
          const record: NotificationRecord = {
            id: `nf-${event.id}-${issue.id}-${index}`,
            workspace: event.tenant,
            recipient,
            kind: "issue_regressed",
            title: `Issue regressed — ${issue.title}`,
            body: note,
            link: { resourceType: "issue", resourceId: issue.id, scorecardId: candidate.id },
            createdAt: event.createdAt,
          };
          await deps.feed?.add(record);
        }
      }
    },
  };
}
