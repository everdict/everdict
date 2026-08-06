import type { NotificationItem } from './schema'

// Where a notification row goes when somebody clicks it.
//
// One resolver, because a notification is only worth firing if it LANDS: the bell, the browser's native
// notification and the desktop shell all navigate from the same record, and a kind that no table knows about
// silently falls back to the workspace home — the click marks the row read and the person never reaches what
// they were told about. That is the failure this table exists to prevent, so it is keyed by the FULL comment
// vocabulary (`COMMENT_RESOURCE_TYPES` in `@everdict/application-control`), not by the subset the bell
// happened to need when the feed only carried datasets.
//
// Two rules the resolver encodes:
//  1. **The subject wins over the evidence.** `issue_regressed` carries both the issue it is about and the
//     scorecard that proved it; the headline says "issue regressed", so the issue is where the click goes.
//  2. **A singular address, never the collection.** `/{ws}/datasets/{id}` still 307s to `/{ws}/dataset/{id}`
//     (`next.config.ts` DETAIL_MOVES), but a redirect DROPS the fragment — measured: a comment mention landed
//     on the dataset page with `#comment-…` stripped, so the thread never scrolled. Addressing one thing by
//     its own segment costs no redirect and keeps the anchor.

// The segment that addresses ONE of these. Every commentable resource is here — a mention with nowhere to go
// is the bug this file fixes.
const RESOURCE_SEGMENT: Record<string, string> = {
  dataset: 'dataset',
  harness: 'harness',
  scorecard: 'scorecard',
  view: 'view',
  // A schedule has a detail page of its own now (it did not when this mapping was written, which is why the
  // bell used to open the EDIT form): the thread being pointed at lives on the detail.
  schedule: 'schedule',
  run: 'run',
  runtime: 'runtime',
  issue: 'issue',
  // The uuid address is a gateway that redirects to the team's numbered cycle — the only spelling a
  // notification can build, since the row records the id and nothing else.
  cycle: 'cycle',
  project: 'project',
  initiative: 'initiative',
}

// The one place a kind overrides the resource's default screen: a posted update is READ on the goal's update
// timeline (a comment mention on the same goal is not — it belongs to the thread on the overview).
function sectionFor(kind: NotificationItem['kind'], resourceType: string): string {
  return kind === 'tracker_update_posted' && resourceType === 'initiative' ? '/updates' : ''
}

// What on that page the click is really about, as a QUERY parameter rather than a `#fragment`: the issue and
// cycle addresses normalize server-side (uuid → `ENG-12`, uuid → the team's cycle number) and a fragment does
// not survive a redirect, while a search parameter does — the pages forward it.
function anchorOf(n: NotificationItem): string {
  if (n.link?.commentId) return `?comment=${encodeURIComponent(n.link.commentId)}`
  if (n.link?.artifactId) return `?artifact=${encodeURIComponent(n.link.artifactId)}`
  return ''
}

export function notificationHref(workspace: string, n: NotificationItem): string {
  const link = n.link
  if (!link) return `/${workspace}`
  // The subject first: a resource link names what the notification is ABOUT, while runId/scorecardId may be
  // the evidence attached to it.
  if (link.resourceType !== undefined && link.resourceId !== undefined) {
    const segment = RESOURCE_SEGMENT[link.resourceType]
    if (segment !== undefined)
      return `/${workspace}/${segment}/${encodeURIComponent(link.resourceId)}${sectionFor(n.kind, link.resourceType)}${anchorOf(n)}`
  }
  // An agent conversation has no page of its own — it opens in the side panel. The address is the workspace
  // home with `?conversation=` (the panel consumes and strips it); the bell short-circuits to opening the
  // panel in place, so this href is the fallback for surfaces that can only navigate (desktop OS click, paste).
  if (link.conversationId !== undefined)
    return `/${workspace}?conversation=${encodeURIComponent(link.conversationId)}`
  if (link.runId !== undefined) return `/${workspace}/run/${encodeURIComponent(link.runId)}`
  if (link.scorecardId !== undefined)
    return `/${workspace}/scorecard/${encodeURIComponent(link.scorecardId)}`
  return `/${workspace}`
}
