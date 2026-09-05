import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'
import type { IssueProjectOption } from './issue-project-control'

// The server action and the router are not this test's subject — what this file locks down is one thing, "can an issue be added to and removed
// from a project in the attribute column" (the old detail screen drew a link only when it was attached, and the route to adding lived inside the
// ⋯ menu's edit dialog).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/issues', () => ({ updateIssueAction: async () => ({ ok: true }) }))

const { IssueProjectControl } = await import('./issue-project-control')

const APOLLO: IssueProjectOption = { id: 'p1', name: 'Apollo', status: 'in_progress' }

const render = (project: IssueProjectOption | undefined, canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueProjectControl
        workspace="acme"
        id="i1"
        project={project}
        projects={[APOLLO]}
        canWrite={canWrite}
      />
    </NextIntlClientProvider>
  )

describe('issue project control', () => {
  it('offers to put an issue that has no project into one', () => {
    const out = render(undefined, true)

    expect(out).toContain('Add to project')
    // The list is only drawn once opened — what is locked down here is "is something openable attached".
    expect(out).toContain('aria-expanded="false"')
  })

  it('keeps the assigned project a link, with the picker next to it', () => {
    const out = render(APOLLO, true)

    expect(out).toContain('href="/acme/project/p1"')
    expect(out).toContain('Apollo')
    // The route to the project (the link) is left as it is, and the place that CHANGES it stands separately beside it.
    expect(out).toContain('aria-expanded="false"')
  })

  it('gives a reader the link only — no picker', () => {
    const out = render(APOLLO, false)

    expect(out).toContain('href="/acme/project/p1"')
    expect(out).not.toContain('aria-expanded')
  })

  it('renders nothing for a reader on an issue with no project', () => {
    expect(render(undefined, false)).toBe('')
  })
})
