import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { IssueOption } from '@/entities/issue'

import en from '../../../../messages/en.json'

// What this file locks down: when one issue mentions another, ① you can cross to that issue and ② you can detach it from the same place.
// The link holds a UUID, so whether the chip is drawn with the identifier and title IS "can a person read this".
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/links', () => ({
  addIssueLinkAction: async () => ({ ok: true }),
  removeIssueLinkAction: async () => ({ ok: true }),
}))

const { IssueMentionControl } = await import('./issue-mention-control')

const MENTIONED: IssueOption = {
  id: '9d2f0a51-0000-4000-8000-000000000001',
  identifier: 'ENG-12',
  title: 'Judge reads a stale rubric',
  status: 'in_progress',
}

const render = (mentions: IssueOption[], canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueMentionControl
        workspace="acme"
        issueId="i1"
        type="issue"
        mentions={mentions}
        canWrite={canWrite}
      />
    </NextIntlClientProvider>
  )

describe('issue mention control', () => {
  it('sends a mentioned issue to its own page, named the way people cite it', () => {
    const out = render([MENTIONED], true)

    expect(out).toContain('href="/acme/issue/ENG-12/judge-reads-a-stale-rubric"')
    expect(out).toContain('ENG-12')
    // A UUID is not a name a person calls something by — it must not leak into the chip.
    expect(out).not.toContain(MENTIONED.id)
  })

  it('offers to take the mention off, right where the chip is', () => {
    expect(render([MENTIONED], true)).toContain('aria-label="Unlink ENG-12"')
  })

  it('offers to add one even when the issue mentions none', () => {
    const out = render([], true)

    expect(out).toContain('Add')
    expect(out).toContain('aria-label="Issues this one mentions"')
    expect(out).toContain('aria-expanded="false"') // the list is only drawn once opened
  })

  it('gives a reader chips only — no unlink, no add', () => {
    const out = render([MENTIONED], false)

    expect(out).toContain('ENG-12')
    expect(out).not.toContain('aria-label="Unlink ENG-12"')
    expect(out).not.toContain('aria-expanded')
  })

  // The reported defect, and the lane it was reported in. A reader's row used to be its own `inline-flex` box —
  // shrink-to-fit, so the chip's percentage max-width resolved against a width derived from the chip's own
  // content and clamped nothing: measured at 380px inside the 188px property column, ellipsis and all. Both
  // branches go through the shared shell now, which is where the two bounds live (shared/ui/chip.test.tsx).
  it('keeps a long title inside the property column, for a reader and for a writer alike', () => {
    for (const out of [render([MENTIONED], false), render([MENTIONED], true)]) {
      expect(out).toContain('max-w-[min(100%,15rem)]')
      expect(out).not.toContain('inline-flex flex-wrap')
      // The identifier is what the issue is cited by, so the title is the half that gives way.
      expect(out).toContain('shrink-0 font-mono')
      expect(out).toContain('min-w-0 truncate')
    }
  })
})
