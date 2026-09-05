import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { IssueLabel } from '@/entities/issue-label'

import en from '../../../../messages/en.json'

// The server action and the router are not this test's subject — what this file locks down is one thing, "can labels be attached and detached in
// the attribute column" (the old detail screen drew the chips only, with editing inside the ⋯ menu's dialog).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/issues', () => ({ updateIssueAction: async () => ({ ok: true }) }))
vi.mock('@/features/manage-issue-labels', () => ({
  createIssueLabelAction: async () => ({ ok: true }),
}))

const { IssueLabelControl } = await import('./issue-label-control')

const BUG: IssueLabel = {
  id: 'l1',
  tenant: 'acme',
  name: 'bug',
  color: 'red',
  createdBy: 'dana',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const render = (labelIds: string[], canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueLabelControl id="i1" labelIds={labelIds} labels={[BUG]} canWrite={canWrite} />
    </NextIntlClientProvider>
  )

describe('issue label control', () => {
  it('offers to take a carried label off, right where the chip is', () => {
    expect(render(['l1'], true)).toContain('aria-label="Remove bug"')
  })

  it('offers to add one even when the issue carries none', () => {
    const out = render([], true)

    expect(out).toContain('Add label')
    // The list is only drawn once opened — what is locked down here is "is something openable attached".
    expect(out).toContain('aria-expanded="false"')
  })

  it('gives a reader chips only — no remove, no add', () => {
    const out = render(['l1'], false)

    expect(out).toContain('bug')
    expect(out).not.toContain('aria-label="Remove bug"')
    expect(out).not.toContain('Add label')
  })
})
