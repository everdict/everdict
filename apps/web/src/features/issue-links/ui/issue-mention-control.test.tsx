import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { IssueOption } from '@/entities/issue'

import en from '../../../../messages/en.json'

// 이 파일이 잠그는 것: 한 이슈가 다른 이슈를 언급하면 ① 그 이슈로 건너갈 수 있고 ② 같은 자리에서 뗄 수 있다.
// 링크가 들고 있는 것은 UUID 라, 칩이 식별자·제목으로 그려지는지가 곧 "사람이 읽을 수 있는가"다.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/links', () => ({
  addIssueLinkAction: async () => ({ ok: true }),
  removeIssueLinkAction: async () => ({ ok: true }),
}))

const { IssueMentionControl } = await import('./issue-mention-control')

const MENTIONED: IssueOption = {
  id: '9d2f0a51-0000-4000-8000-000000000001',
  identifier: 'ENG-12',
  title: 'Judge reads a stale rubric',
  status: 'in_progress',
}

const render = (mentions: IssueOption[], canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueMentionControl
        workspace="acme"
        issueId="i1"
        type="issue"
        mentions={mentions}
        canWrite={canWrite}
      />
    </NextIntlClientProvider>
  )

describe('issue mention control', () => {
  it('sends a mentioned issue to its own page, named the way people cite it', () => {
    const out = render([MENTIONED], true)

    expect(out).toContain('href="/acme/issue/ENG-12/judge-reads-a-stale-rubric"')
    expect(out).toContain('ENG-12')
    // UUID 는 사람이 부르는 이름이 아니다 — 칩에 새어 나오면 안 된다.
    expect(out).not.toContain(MENTIONED.id)
  })

  it('offers to take the mention off, right where the chip is', () => {
    expect(render([MENTIONED], true)).toContain('aria-label="Unlink ENG-12"')
  })

  it('offers to add one even when the issue mentions none', () => {
    const out = render([], true)

    expect(out).toContain('Add')
    expect(out).toContain('aria-label="Issues this one mentions"')
    expect(out).toContain('aria-expanded="false"') // 목록은 열어야 그려진다
  })

  it('gives a reader chips only — no unlink, no add', () => {
    const out = render([MENTIONED], false)

    expect(out).toContain('ENG-12')
    expect(out).not.toContain('aria-label="Unlink ENG-12"')
    expect(out).not.toContain('aria-expanded')
  })
})
