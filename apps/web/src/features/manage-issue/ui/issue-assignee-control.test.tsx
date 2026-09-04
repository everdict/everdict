import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'

// The server action and the router are not this test's subject — what this file locks down is one thing, "is there a place to assign an
// assignee" (the old detail screen drew a single name line only when someone was already assigned, and the only route to assigning a person was
// the list row).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/issues', () => ({ updateIssueAction: async () => ({ ok: true }) }))

const { IssueAssigneeControl } = await import('./issue-assignee-control')

const ACTORS = { 'u-1': { name: 'Ada Lovelace' } }
const MEMBERS = [{ subject: 'u-1', name: 'Ada Lovelace' }]

const render = (
  assignee: string | undefined,
  canWrite: boolean,
  variant?: 'default' | 'icon'
): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueAssigneeControl
        id="i1"
        {...(assignee !== undefined ? { assignee } : {})}
        actors={ACTORS}
        members={MEMBERS}
        canWrite={canWrite}
        {...(variant !== undefined ? { variant } : {})}
      />
    </NextIntlClientProvider>
  )

describe('issue assignee control', () => {
  it('offers to assign an issue that has nobody on it', () => {
    const out = render(undefined, true)

    expect(out).toContain('Unassigned')
    // The list is only drawn once opened — what is locked down here is "is something openable attached".
    expect(out).toContain('aria-expanded="false"')
  })

  it('names the assignee in the property column, with the picker on it', () => {
    const out = render('u-1', true)

    expect(out).toContain('Ada Lovelace')
    expect(out).toContain('aria-expanded="false"')
  })

  it('shows a reader the name with no picker', () => {
    const out = render('u-1', false)

    expect(out).toContain('Ada Lovelace')
    expect(out).not.toContain('aria-expanded')
  })

  it('keeps the list row to the face alone', () => {
    const out = render('u-1', true, 'icon')

    // On a row the FACE alone stands rather than the name — the name is attached only as a title (the density of a place you sweep).
    expect(out).toContain('title="Ada Lovelace"')
    expect(out).not.toContain('<span class="truncate">Ada Lovelace</span>')
  })
})
