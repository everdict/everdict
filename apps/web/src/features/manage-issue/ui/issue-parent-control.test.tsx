import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'
import type { IssueParentOption } from './issue-parent-control'

// The server action and the router are not this test's subject — what this file locks down is two things: "when a sub-issue is opened, can you
// tell WHAT it is a sub-issue of, and can that belonging be changed here" (it used to be the single `ENG-11` fragment in the breadcrumb,
// with nowhere on screen to attach or detach).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/issues', () => ({ updateIssueAction: async () => ({ ok: true }) }))

const { IssueParentControl } = await import('./issue-parent-control')

const EPIC: IssueParentOption = {
  id: 'i9',
  identifier: 'ENG-11',
  title: 'the judge drops cost scores',
  status: 'in_progress',
}

const render = (parent: IssueParentOption | undefined, canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueParentControl
        workspace="acme"
        id="i1"
        parent={parent}
        options={[EPIC]}
        canWrite={canWrite}
      />
    </NextIntlClientProvider>
  )

describe('issue parent control', () => {
  it('names the parent — identifier AND title, so a sub-issue says what it broke out of', () => {
    const out = render(EPIC, true)

    expect(out).toContain('ENG-11')
    expect(out).toContain('the judge drops cost scores')
    // The route to the parent stays a LINK (it is the only way from the attribute column to the parent issue).
    expect(out).toContain('href="/acme/issue/ENG-11/the-judge-drops-cost-scores"')
  })

  it('offers to put a top-level issue under a parent', () => {
    const out = render(undefined, true)

    expect(out).toContain('Set parent')
    // The list is only drawn once opened — what is locked down here is "is something openable attached".
    expect(out).toContain('aria-expanded="false"')
  })

  it('gives a reader the link only — no picker', () => {
    const out = render(EPIC, false)

    expect(out).toContain('ENG-11')
    expect(out).not.toContain('aria-expanded')
  })

  it('renders nothing for a reader on a top-level issue', () => {
    expect(render(undefined, false)).toBe('')
  })
})
