import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'
import type { IssueProjectOption } from './issue-project-control'

// 서버 액션과 라우터는 이 테스트의 대상이 아니다 — 이 파일이 잠그는 것은 "속성 열에서 이슈를 프로젝트에
// 넣고 뺄 수 있는가" 하나다(예전 상세 화면은 붙어 있을 때만 링크를 그렸고, 넣는 길은 ⋯ 메뉴의 편집
// 다이얼로그 안에만 있었다).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/issues', () => ({ updateIssueAction: async () => ({ ok: true }) }))

const { IssueProjectControl } = await import('./issue-project-control')

const APOLLO: IssueProjectOption = { id: 'p1', name: 'Apollo', status: 'in_progress' }

const render = (project: IssueProjectOption | undefined, canWrite: boolean): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueProjectControl
        workspace="acme"
        id="i1"
        project={project}
        projects={[APOLLO]}
        canWrite={canWrite}
      />
    </NextIntlClientProvider>
  )

describe('issue project control', () => {
  it('offers to put an issue that has no project into one', () => {
    const out = render(undefined, true)

    expect(out).toContain('Add to project')
    // 목록은 열어야 그려진다 — 여기서 잠그는 것은 "열 수 있는 것이 붙어 있는가"다.
    expect(out).toContain('aria-expanded="false"')
  })

  it('keeps the assigned project a link, with the picker next to it', () => {
    const out = render(APOLLO, true)

    expect(out).toContain('href="/acme/projects/p1"')
    expect(out).toContain('Apollo')
    // 프로젝트로 가는 길(링크)은 그대로 두고, 바꾸는 자리는 그 옆에 따로 선다.
    expect(out).toContain('aria-expanded="false"')
  })

  it('gives a reader the link only — no picker', () => {
    const out = render(APOLLO, false)

    expect(out).toContain('href="/acme/projects/p1"')
    expect(out).not.toContain('aria-expanded')
  })

  it('renders nothing for a reader on an issue with no project', () => {
    expect(render(undefined, false)).toBe('')
  })
})
