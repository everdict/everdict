import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { PlatformEvent } from '@/entities/platform-event'

import en from '../../../../messages/en.json'
import { ActivityEventRow } from './activity-event-row'

// The home feed has to say WHAT happened, not just that something did — the old row printed
// "Issue [status changed]" for every transition and dropped the payload's material (who, which one,
// from where to where, at what pass rate) on the floor. These lock the summary in.

const DIRECTORY = { dana: { name: 'Dana' } }

const render = (event: PlatformEvent): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <ActivityEventRow
        event={event}
        workspace="acme"
        directory={DIRECTORY}
        locale="en"
        timeZone="UTC"
      />
    </NextIntlClientProvider>
  )

function evt(overrides: Partial<PlatformEvent>): PlatformEvent {
  return {
    id: 'evt-1',
    seq: 1,
    tenant: 'acme',
    kind: 'issue.created',
    subject: { type: 'issue', id: 'iss-1' },
    payload: {},
    message: 'the raw recorded line',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('workspace activity row', () => {
  it('names the actor, cites the issue and shows both ends of a status move', () => {
    const out = render(
      evt({
        kind: 'issue.status_changed',
        actor: 'dana',
        payload: {
          from: 'todo',
          to: 'in_progress',
          cause: 'manual',
          identifier: 'ENG-1',
          title: 'Agent drops the tool result on retry',
        },
      })
    )
    expect(out).toContain('Dana')
    expect(out).toContain('ENG-1')
    expect(out).toContain('Agent drops the tool result on retry')
    expect(out).toContain('Todo')
    expect(out).toContain('In progress')
    // A member-made move says nothing about a cause — the chip is reserved for the non-manual ones.
    expect(out).not.toContain('Regression watch')
    // With material on the line, the raw English message stays on hover (a title attribute) only —
    // it must not appear as a text node.
    expect(out).not.toContain('>the raw recorded line<')
  })

  it('summarizes a finished batch with what ran and how it scored', () => {
    const out = render(
      evt({
        kind: 'scorecard.completed',
        subject: { type: 'scorecard', id: 'sc-1' },
        payload: { dataset: 'browser-suite@1.2.0', harness: 'web-agent@2.0.0', passRate: 0.92 },
      })
    )
    expect(out).toContain('web-agent')
    expect(out).toContain('browser-suite')
    expect(out).toContain('92%')
  })

  it('cites a project by name and an approval by its decision', () => {
    const project = render(
      evt({
        kind: 'project.status_changed',
        subject: { type: 'project', id: 'prj-1' },
        payload: { from: 'planned', to: 'started', name: 'v1 agent launch' },
      })
    )
    expect(project).toContain('v1 agent launch')

    const approval = render(
      evt({
        kind: 'approval.decided',
        subject: { type: 'approval', id: 'ap-1' },
        payload: { decision: 'denied', tool: 'delete_dataset' },
      })
    )
    expect(approval).toContain('denied')
    expect(approval).toContain('delete_dataset')
  })

  it('shows the published path, and quotes a comment', () => {
    const file = render(
      evt({
        kind: 'file.published',
        subject: { type: 'file', id: 'tasks/abc/report.md' },
        payload: { path: 'tasks/abc/report.md', revision: 3 },
      })
    )
    expect(file).toContain('tasks/abc/report.md')

    const comment = render(
      evt({
        kind: 'comment.created',
        subject: { type: 'issue', id: 'iss-1' },
        payload: { commentId: 'c-1', excerpt: 'The judge rewrite slipped a week.' },
      })
    )
    expect(comment).toContain('The judge rewrite slipped a week.')
  })

  it('falls back to the recorded message only when the payload offers nothing to read', () => {
    const out = render(
      evt({ kind: 'trace.ingestion_throttled', subject: { type: 'workspace', id: 'acme' } })
    )
    expect(out).toContain('>the raw recorded line<')
  })
})
