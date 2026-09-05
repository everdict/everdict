import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'

// What this file locks down: an issue can be attached from the harness, dataset and judge screens too, and that place is visible only to
// someone who can EDIT AN ISSUE (the link is written on the issue record, so issues:write decides it — not a permission on the capability).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('@/features/issue-links', () => ({ addIssueLinkAction: async () => ({ ok: true }) }))

const { LinkIssueButton } = await import('./link-issue-button')

const render = (canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <LinkIssueButton
        type="harness"
        capabilityId="browser-suite"
        canWrite={canWrite}
        linkedIssueIds={['i1']}
      />
    </NextIntlClientProvider>
  )

describe('link issue button', () => {
  it('offers to link an issue from the capability side', () => {
    const out = render(true)

    expect(out).toContain('Link an issue')
    expect(out).toContain('aria-expanded="false"') // the search list is only drawn once opened
  })

  it('shows a reader nothing — linking is a write on the issue', () => {
    expect(render(false)).toBe('')
  })
})
