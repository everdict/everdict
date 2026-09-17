import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { IssueLink } from '@/entities/issue'

import en from '../../../../messages/en.json'

// What this file locks down: the commit chip is a way OUT of this workspace, and it has to leave correctly.
// Every other link on this screen goes to a route here, so the two things that can silently be wrong are the
// address (a route-shaped href instead of the forge's) and the target (navigating the tab away from the issue
// the reader is working on, instead of opening beside it).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/links', () => ({
  addIssueLinkAction: async () => ({ ok: true }),
  removeIssueLinkAction: async () => ({ ok: true }),
}))

const { IssueCommitControl } = await import('./issue-commit-control')

const COMMIT: IssueLink = {
  type: 'commit',
  id: 'e4fe66e8bfcbebc342115226033654cd2280f07b',
  repository: 'PPP-Atelier/digo-mobile',
  addedBy: 'dana',
  addedAt: '2026-09-17T00:00:00.000Z',
}

const render = (links: IssueLink[], canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueCommitControl issueId="i1" links={links} canWrite={canWrite} />
    </NextIntlClientProvider>
  )

describe('issue commit control', () => {
  it('addresses the forge, not a route in this workspace', () => {
    const out = render([COMMIT], true)

    expect(out).toContain(
      'href="https://github.com/PPP-Atelier/digo-mobile/commit/e4fe66e8bfcbebc342115226033654cd2280f07b"'
    )
    // The tab stays on the issue: the reader is mid-triage, and a commit is something they GLANCE at.
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noreferrer"')
  })

  it('names the repository beside the abbreviation, because a sha alone identifies nothing', () => {
    const out = render([COMMIT], false)

    expect(out).toContain('PPP-Atelier/digo-mobile@e4fe66e')
    // The full sha belongs in the tooltip, where the whole of it fits — not in a chip that would truncate it
    // to something that looks like a different commit.
    expect(out).toContain('e4fe66e8bfcbebc342115226033654cd2280f07b')
  })

  it('uses the Enterprise host when the link carries one', () => {
    const out = render([{ ...COMMIT, repository: 'acme/app', host: 'ghe.internal' }], false)

    expect(out).toContain('href="https://ghe.internal/acme/app/commit/')
    expect(out).not.toContain('github.com')
  })

  // A reader without write access sees the commits and no affordance to change them; a row with neither is
  // not drawn at all, which is the difference between "nothing here" and an empty control.
  it('draws nothing for a reader when there are no commits, and no unlink button when there are', () => {
    expect(render([], false)).toBe('')
    expect(render([COMMIT], false)).not.toContain('<button')
    expect(render([COMMIT], true)).toContain('aria-label="Unlink e4fe66e"')
  })

  it('offers the paste affordance to a writer even with nothing attached', () => {
    const out = render([], true)

    expect(out).toContain('Add')
    expect(out).toContain('aria-label="Commits that changed this"')
  })
})
