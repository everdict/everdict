import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import en from '../../../../messages/en.json'
import { PermissionPrompt, type PendingPermission } from './permission-prompt'

// 승인 카드는 채팅 패널과 코멘트 스레드(discuss 의 ApprovalStrip)가 같이 쓰는 하나의 렌더러다. 이 파일이
// 잠그는 것은 "무엇을 실행하려는지 보고 결정할 수 있는가" — 도구 이름만 있고 인자가 없는 승인 카드는
// 코멘트 스레드에서 실제로 겪은 결함이라, 인자 프리뷰가 카드의 해부에서 빠지지 않게 고정한다.

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
    // 인자 프리뷰가 그려져야 승인자가 대상(ENG-12)을 보고 결정할 수 있다.
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
