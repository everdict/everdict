import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import en from '../../../../messages/en.json'
import { PermissionPrompt, type PendingPermission } from './permission-prompt'

// The approval card is ONE renderer shared by the chat panel and the comment thread (discuss' ApprovalStrip). What this file
// locks down is "can you see what is about to run and decide" — an approval card with only a tool name and no arguments is a defect actually
// experienced in the comment thread, so it pins the argument preview into the card's anatomy.

const render = (pending: PendingPermission[]): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <PermissionPrompt pending={pending} onDecide={() => {}} />
    </NextIntlClientProvider>
  )

describe('permission prompt', () => {
  it('shows WHAT the tool would touch, not just its name', () => {
    const out = render([
      {
        requestId: 'r1',
        name: 'update_issue',
        input: { id: 'ENG-12', patch: { status: 'done' } },
      },
    ])

    expect(out).toContain('update_issue')
    // The argument preview has to be drawn for an approver to see the TARGET (ENG-12) and decide.
    expect(out).toContain('ENG-12')
    expect(out).toContain('<pre')
  })

  it('keeps the card decidable when the ask carries no arguments', () => {
    const out = render([{ requestId: 'r1', name: 'refresh_cache', input: undefined }])

    expect(out).toContain('refresh_cache')
    expect(out).not.toContain('<pre')
  })

  it('caps a huge argument payload instead of flooding the card', () => {
    const out = render([{ requestId: 'r1', name: 'write_file', input: 'x'.repeat(700) }])

    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(601))
  })
})
