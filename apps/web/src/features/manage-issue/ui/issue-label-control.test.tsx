import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { IssueLabel } from '@/entities/issue-label'

import en from '../../../../messages/en.json'

// 서버 액션과 라우터는 이 테스트의 대상이 아니다 — 이 파일이 잠그는 것은 "속성 열에서 라벨을 붙이고 뗄 수
// 있는가" 하나다(예전 상세 화면은 칩만 그렸고, 편집은 ⋯ 메뉴의 다이얼로그 안에만 있었다).
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
    // 목록은 열어야 그려진다 — 여기서 잠그는 것은 "열 수 있는 것이 붙어 있는가"다.
    expect(out).toContain('aria-expanded="false"')
  })

  it('gives a reader chips only — no remove, no add', () => {
    const out = render(['l1'], false)

    expect(out).toContain('bug')
    expect(out).not.toContain('aria-label="Remove bug"')
    expect(out).not.toContain('Add label')
  })
})
