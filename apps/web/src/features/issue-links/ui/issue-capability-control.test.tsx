import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { IssueLink } from '@/entities/issue'

import en from '../../../../messages/en.json'

// 서버 액션과 라우터는 이 테스트의 대상이 아니다 — 이 파일이 잠그는 것은 "이슈를 검증하는 능력을 속성 열에서
// 골라 붙일 수 있는가, 그리고 붙은 것에서 그 능력으로 건너갈 수 있는가" 둘이다(예전에는 id 를 손으로 적는
// 자유 입력 폼이었고, 오타 하나면 아무 데도 가리키지 않는 링크가 만들어졌다).
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
    // 목록은 열어야 그려진다 — 여기서 잠그는 것은 "열 수 있는 것이 붙어 있는가"다.
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
