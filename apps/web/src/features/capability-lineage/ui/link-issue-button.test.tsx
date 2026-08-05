import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'

// 이 파일이 잠그는 것: 하네스·데이터셋·저지 화면에서도 이슈를 걸 수 있고, 그 자리는 이슈를 고칠 수 있는
// 사람에게만 보인다(링크는 이슈 레코드에 쓰이므로 능력의 권한이 아니라 issues:write 가 판정한다).
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
    expect(out).toContain('aria-expanded="false"') // 검색 목록은 열어야 그려진다
  })

  it('shows a reader nothing — linking is a write on the issue', () => {
    expect(render(false)).toBe('')
  })
})
