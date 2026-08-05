import { describe, expect, it } from 'vitest'

import { notificationHref } from './href'
import { notificationKinds, type NotificationItem, type NotificationKind } from './schema'

// Every notification kind, and every resource a comment can be attached to, has to LAND somewhere real: a row
// whose link nothing understands falls back to the workspace home, and the click still marks it read — so the
// person is told about something and can never reach it. These cases are that guarantee.
function row(kind: NotificationKind, link?: NotificationItem['link']): NotificationItem {
  return {
    id: 'n1',
    workspace: 'acme',
    recipient: 'dev',
    kind,
    title: 'title',
    ...(link !== undefined ? { link } : {}),
    createdAt: '2026-08-05T00:00:00.000Z',
  }
}

describe('notificationHref', () => {
  it('opens a completed run and scorecard at their own detail address', () => {
    expect(notificationHref('acme', row('run_completed', { runId: 'r1' }))).toBe('/acme/run/r1')
    expect(notificationHref('acme', row('scorecard_failed', { scorecardId: 's1' }))).toBe(
      '/acme/scorecard/s1'
    )
    expect(notificationHref('acme', row('schedule_completed', { scorecardId: 's2' }))).toBe(
      '/acme/scorecard/s2'
    )
  })

  // The regression that started this: an @mention on an issue or a cycle had no mapping at all, so the click
  // went to the workspace home and the mention was consumed unread-to-read on the way.
  it.each([
    ['issue', '/acme/issue/i1?comment=c1'],
    ['cycle', '/acme/cycle/i1?comment=c1'],
    ['project', '/acme/project/i1?comment=c1'],
    ['initiative', '/acme/initiative/i1?comment=c1'],
    ['dataset', '/acme/dataset/i1?comment=c1'],
    ['harness', '/acme/harness/i1?comment=c1'],
    ['scorecard', '/acme/scorecard/i1?comment=c1'],
    ['view', '/acme/view/i1?comment=c1'],
    ['schedule', '/acme/schedule/i1?comment=c1'],
    ['run', '/acme/run/i1?comment=c1'],
    ['runtime', '/acme/runtime/i1?comment=c1'],
  ])('reaches the mentioned comment on a %s', (resourceType, expected) => {
    const href = notificationHref(
      'acme',
      row('comment_mention', { resourceType, resourceId: 'i1', commentId: 'c1' })
    )
    expect(href).toBe(expected)
  })

  // The scorecard is the EVIDENCE; the headline is about the issue, so that is where the reader is taken.
  it('opens the issue a regression is about, not the scorecard that proved it', () => {
    expect(
      notificationHref(
        'acme',
        row('issue_regressed', { resourceType: 'issue', resourceId: 'i1', scorecardId: 's1' })
      )
    ).toBe('/acme/issue/i1')
  })

  // A posted update is read on the goal's update timeline; a mention on that same goal belongs to the thread
  // on its overview — one resource, two screens, decided by the kind.
  it('sends an initiative update to the update timeline and a mention to the overview', () => {
    const link = { resourceType: 'initiative', resourceId: 'g1' }
    expect(notificationHref('acme', row('tracker_update_posted', link))).toBe(
      '/acme/initiative/g1/updates'
    )
    expect(notificationHref('acme', row('comment_mention', { ...link, commentId: 'c9' }))).toBe(
      '/acme/initiative/g1?comment=c9'
    )
  })

  it('sends a project update to the project, where its updates are posted', () => {
    expect(
      notificationHref(
        'acme',
        row('tracker_update_posted', { resourceType: 'project', resourceId: 'p1' })
      )
    ).toBe('/acme/project/p1')
  })

  it('points a ready report at the artifact it produced', () => {
    expect(
      notificationHref(
        'acme',
        row('report_completed', { resourceType: 'view', resourceId: 'v1', artifactId: 'a1' })
      )
    ).toBe('/acme/view/v1?artifact=a1')
  })

  it('escapes an id that would otherwise break out of its segment', () => {
    expect(
      notificationHref(
        'acme',
        row('comment_mention', { resourceType: 'dataset', resourceId: 'a/b' })
      )
    ).toBe('/acme/dataset/a%2Fb')
  })

  it('falls back to the workspace when there is nothing to open', () => {
    expect(notificationHref('acme', row('run_completed'))).toBe('/acme')
    expect(
      notificationHref('acme', row('comment_mention', { resourceType: 'moon', resourceId: 'm1' }))
    ).toBe('/acme')
  })

  // A kind is only worth firing if a click on it goes somewhere — so no kind may reach the feed without this
  // resolver having an answer for the link it carries.
  it('resolves an address for every registered kind', () => {
    for (const kind of notificationKinds) {
      const href = notificationHref(
        'acme',
        row(kind, { resourceType: 'issue', resourceId: 'i1', runId: 'r1', scorecardId: 's1' })
      )
      expect(href.startsWith('/acme/')).toBe(true)
    }
  })
})
