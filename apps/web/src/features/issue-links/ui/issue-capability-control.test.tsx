import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { IssueLink } from '@/entities/issue'

import en from '../../../../messages/en.json'

// The server action and the router are not this test's subject — what this file locks down is two things: "can a capability that verifies the
// issue be picked and attached from the attribute column, and can you cross from an attached one to that capability" (it used to be a free-input
// form where the id was typed by hand, and one typo made a link pointing nowhere).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/links', () => ({
  addIssueLinkAction: async () => ({ ok: true }),
  removeIssueLinkAction: async () => ({ ok: true }),
}))

const { IssueCapabilityControl } = await import('./issue-capability-control')

const LINK: IssueLink = {
  type: 'harness',
  id: 'browser-suite',
  addedBy: 'dana',
  addedAt: '2026-08-01T00:00:00.000Z',
}

const render = (links: IssueLink[], canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueCapabilityControl
        workspace="acme"
        issueId="i1"
        type="harness"
        links={links}
        options={[{ id: 'browser-suite' }, { id: 'swe-bench-runner', hint: 'claude-code' }]}
        canWrite={canWrite}
      />
    </NextIntlClientProvider>
  )

describe('issue capability control', () => {
  it('offers registered capabilities to pick, even when the issue links none', () => {
    const out = render([], true)

    expect(out).toContain('Add')
    // The list is only drawn once opened — what is locked down here is "is something openable attached".
    expect(out).toContain('aria-expanded="false"')
    expect(out).toContain('aria-label="Harness links on this issue"')
  })

  it('sends a linked capability to its own detail page', () => {
    expect(render([LINK], true)).toContain('href="/acme/harness/browser-suite"')
  })

  it('offers to unlink right where the chip is', () => {
    expect(render([LINK], true)).toContain('aria-label="Unlink browser-suite"')
  })

  it('keeps a pinned version visible — the link an agent made says what it meant', () => {
    expect(render([{ ...LINK, version: '1.2.0' }], true)).toContain('1.2.0')
  })

  it('gives a reader chips only — no unlink, no add', () => {
    const out = render([LINK], false)

    expect(out).toContain('browser-suite')
    expect(out).not.toContain('aria-label="Unlink browser-suite"')
    expect(out).not.toContain('aria-expanded')
  })
})
