import type {
  InitiativeBlocker,
  InitiativeProjectSummary,
  InitiativeReadiness,
  IssueRecord,
  IssueStatus,
  ProjectRecord,
  ProjectRollup,
} from "@everdict/contracts";
import { INITIATIVE_BLOCKER_LIMIT, ISSUE_STATUSES } from "@everdict/contracts";
import { isOpenIssueStatus } from "./issue.js";

// Rollup + readiness are PURE arithmetic over the issues a caller already fetched — no store, no I/O. They run
// on detail reads (never stored) for the same reason ScorecardRecord.trialSummary is derived: a cached count is
// a cache to invalidate on every child write, and the number is cheap.

export function projectRollup(issues: readonly IssueRecord[]): ProjectRollup {
  // Every status key is present (zeroed) so consumers never branch on undefined — the null-discipline rule
  // applies to derived shapes too.
  const byStatus = Object.fromEntries(ISSUE_STATUSES.map((status) => [status, 0])) as Record<IssueStatus, number>;
  let open = 0;
  let done = 0;
  let cancelled = 0;
  let evaluated = 0;
  for (const issue of issues) {
    byStatus[issue.status] += 1;
    if (isOpenIssueStatus(issue.status)) open += 1;
    if (issue.status === "done") {
      done += 1;
      // "Resolved" and "resolved with evidence" are different claims — a release conversation cares which.
      if (issue.resolution?.scorecardId !== undefined) evaluated += 1;
    }
    if (issue.status === "cancelled") cancelled += 1;
  }
  return { total: issues.length, open, done, cancelled, byStatus, evaluated, ready: open === 0 };
}

// The deployment verdict. Open issues are counted across every non-cancelled project REGARDLESS of that
// project's own status: a project marked completed whose issue later regressed still blocks the release. The
// project status is history; readiness is live truth.
//
// `projects` is everything claimed by THIS initiative or any of its descendants — the service walks the tree
// (it holds the store); the arithmetic here stays pure. A project that does not name the initiative directly
// came up through a descendant, and the summary says which, so a blocked release can point at where the block
// actually sits instead of just at the umbrella.
export function initiativeReadiness(
  initiativeId: string,
  projects: readonly ProjectRecord[],
  issuesByProject: ReadonlyMap<string, readonly IssueRecord[]>,
): InitiativeReadiness {
  const summaries: InitiativeProjectSummary[] = [];
  const blockers: InitiativeBlocker[] = [];
  let openIssues = 0;
  let totalIssues = 0;
  for (const project of projects) {
    const issues = issuesByProject.get(project.id) ?? [];
    const rollup = projectRollup(issues);
    // Directly claimed = no "via". Otherwise the first descendant on the project's list — a project serving two
    // descendants of the same initiative is one umbrella's business either way.
    const via = project.initiativeIds.includes(initiativeId)
      ? undefined
      : project.initiativeIds.find((id) => id !== initiativeId);
    summaries.push({
      id: project.id,
      name: project.name,
      ...(via !== undefined ? { viaInitiativeId: via } : {}),
      status: project.status,
      ...(project.targetDate !== undefined ? { targetDate: project.targetDate } : {}),
      ...(project.completedAt !== undefined ? { completedAt: project.completedAt } : {}),
      rollup,
    });
    if (project.status === "cancelled") continue; // a cancelled project's work is off the release, not pending
    totalIssues += rollup.total;
    openIssues += rollup.open;
    for (const issue of issues) {
      if (!isOpenIssueStatus(issue.status)) continue;
      blockers.push({
        projectId: project.id,
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
      });
    }
  }
  // Regressions first, then the rest: the readiness card should lead with what broke, not with the backlog.
  blockers.sort((a, b) => Number(b.status === "regressed") - Number(a.status === "regressed"));
  return {
    ready: openIssues === 0,
    openIssues,
    totalIssues,
    projects: summaries,
    blockers: blockers.slice(0, INITIATIVE_BLOCKER_LIMIT),
  };
}
