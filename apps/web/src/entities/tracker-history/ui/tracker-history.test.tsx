import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { TrackerHistoryEntry } from '@/entities/issue'

import en from '../../../../messages/en.json'
import { TrackerHistory } from './tracker-history'

// A history row has to name what changed, not just that something did — the old renderer printed
// "Status changed · dana · 5/1/2026" for every transition, which reads the same whether an issue moved to
// review or regressed off its baseline. These lock the values in.

const ACTORS = { dana: { name: 'Dana' } }

const render = (entries: TrackerHistoryEntry[]): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <TrackerHistory
        kind="issue"
        subject="issue"
        entries={entries}
        actors={ACTORS}
        workspace="acme"
      />
    </NextIntlClientProvider>
  )

describe('tracker history', () => {
  it('names both ends of a status move and who made it', () => {
    const out = render([
      {
        at: '2026-05-01T10:00:00.000Z',
        by: 'dana',
        event: 'status_changed',
        detail: { from: 'todo', to: 'in_progress', cause: 'manual' },
      },
    ])

    expect(out).toContain('Dana')
    expect(out).toContain('changed status')
    expect(out).toContain('Todo')
    expect(out).toContain('In progress')
    // A member-made move says nothing about a cause — the chip is reserved for the non-manual ones.
    expect(out).not.toContain('Regression watch')
  })

  it('credits the regression watch when the reopen was not a person', () => {
    const out = render([
      {
        at: '2026-05-02T10:00:00.000Z',
        by: 'system',
        event: 'reopened',
        detail: { from: 'done', to: 'regressed', cause: 'regression', scorecardId: 'sc_1' },
      },
    ])

    expect(out).toContain('Regression watch')
    expect(out).toContain('Regressed')
    expect(out).toContain('sc_1')
  })

  it('links what was linked, and lists the fields an edit touched', () => {
    const out = render([
      {
        at: '2026-05-03T10:00:00.000Z',
        by: 'dana',
        event: 'linked',
        detail: { type: 'dataset', id: 'browser-suite', version: '1.2.0' },
      },
      {
        at: '2026-05-04T10:00:00.000Z',
        by: 'dana',
        event: 'updated',
        detail: { changed: ['title', 'labels'] },
      },
    ])

    expect(out).toContain('/acme/datasets/browser-suite')
    expect(out).toContain('browser-suite')
    expect(out).toContain('1.2.0')
    expect(out).toContain('title, labels')
  })

  it('survives a detail bag that carries none of what the event usually says', () => {
    const out = render([{ at: '2026-05-05T10:00:00.000Z', by: 'dana', event: 'status_changed' }])

    expect(out).toContain('changed status')
  })
})
