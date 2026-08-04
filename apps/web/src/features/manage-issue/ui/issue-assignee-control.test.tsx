import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'

// 서버 액션과 라우터는 이 테스트의 대상이 아니다 — 이 파일이 잠그는 것은 "담당자를 지정할 자리가 있는가"
// 하나다(예전 상세 화면은 이미 맡은 사람이 있을 때만 이름 한 줄을 그렸고, 사람을 지정할 길은 목록 행에만
// 있었다).
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('../api/issues', () => ({ updateIssueAction: async () => ({ ok: true }) }))

const { IssueAssigneeControl } = await import('./issue-assignee-control')

const ACTORS = { 'u-1': { name: 'Ada Lovelace' } }
const MEMBERS = [{ subject: 'u-1', name: 'Ada Lovelace' }]

const render = (
  assignee: string | undefined,
  canWrite: boolean,
  variant?: 'default' | 'icon'
): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <IssueAssigneeControl
        id="i1"
        {...(assignee !== undefined ? { assignee } : {})}
        actors={ACTORS}
        members={MEMBERS}
        canWrite={canWrite}
        {...(variant !== undefined ? { variant } : {})}
      />
    </NextIntlClientProvider>
  )

describe('issue assignee control', () => {
  it('offers to assign an issue that has nobody on it', () => {
    const out = render(undefined, true)

    expect(out).toContain('Unassigned')
    // 목록은 열어야 그려진다 — 여기서 잠그는 것은 "열 수 있는 것이 붙어 있는가"다.
    expect(out).toContain('aria-expanded="false"')
  })

  it('names the assignee in the property column, with the picker on it', () => {
    const out = render('u-1', true)

    expect(out).toContain('Ada Lovelace')
    expect(out).toContain('aria-expanded="false"')
  })

  it('shows a reader the name with no picker', () => {
    const out = render('u-1', false)

    expect(out).toContain('Ada Lovelace')
    expect(out).not.toContain('aria-expanded')
  })

  it('keeps the list row to the face alone', () => {
    const out = render('u-1', true, 'icon')

    // 행에서는 이름이 아니라 얼굴만 선다 — 이름은 title 로만 붙는다(훑는 자리의 밀도).
    expect(out).toContain('title="Ada Lovelace"')
    expect(out).not.toContain('<span class="truncate">Ada Lovelace</span>')
  })
})
