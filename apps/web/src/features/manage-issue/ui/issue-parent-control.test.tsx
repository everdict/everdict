import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'
import type { IssueParentOption } from './issue-parent-control'

// 서버 액션과 라우터는 이 테스트의 대상이 아니다 — 이 파일이 잠그는 것은 "하위 이슈를 열었을 때 무엇의
// 하위인지 알 수 있는가, 그리고 그 소속을 여기서 바꿀 수 있는가" 둘이다(예전에는 브레드크럼의 `ENG-11`
// 한 조각뿐이었고, 붙이거나 떼는 길은 화면 어디에도 없었다).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/issues', () => ({ updateIssueAction: async () => ({ ok: true }) }))

const { IssueParentControl } = await import('./issue-parent-control')

const EPIC: IssueParentOption = {
  id: 'i9',
  identifier: 'ENG-11',
  title: 'the judge drops cost scores',
  status: 'in_progress',
}

const render = (parent: IssueParentOption | undefined, canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueParentControl
        workspace="acme"
        id="i1"
        parent={parent}
        options={[EPIC]}
        canWrite={canWrite}
      />
    </NextIntlClientProvider>
  )

describe('issue parent control', () => {
  it('names the parent — identifier AND title, so a sub-issue says what it broke out of', () => {
    const out = render(EPIC, true)

    expect(out).toContain('ENG-11')
    expect(out).toContain('the judge drops cost scores')
    // 부모로 가는 길은 링크로 남는다(속성 열에서 상위 이슈로 가는 유일한 길이다).
    expect(out).toContain('href="/acme/issue/ENG-11/the-judge-drops-cost-scores"')
  })

  it('offers to put a top-level issue under a parent', () => {
    const out = render(undefined, true)

    expect(out).toContain('Set parent')
    // 목록은 열어야 그려진다 — 여기서 잠그는 것은 "열 수 있는 것이 붙어 있는가"다.
    expect(out).toContain('aria-expanded="false"')
  })

  it('gives a reader the link only — no picker', () => {
    const out = render(EPIC, false)

    expect(out).toContain('ENG-11')
    expect(out).not.toContain('aria-expanded')
  })

  it('renders nothing for a reader on a top-level issue', () => {
    expect(render(undefined, false)).toBe('')
  })
})
