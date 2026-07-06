'use client'

import { useState, useTransition } from 'react'
import { ExternalLink, GitPullRequest } from 'lucide-react'

import { Button } from '@/shared/ui/button'

import { openSetupPrAction } from '../api/manage-ci-links'

// 셋업 PR 열기 — link 의 워크플로 YAML 을 대상 레포에 PR(워크스페이스 GitHub App 토큰). 성공 시 새 탭으로 PR 을 연다.
// App 이 그 레포에 설치돼 있지 않으면 컨트롤플레인이 404 → onError 로 안내.
export function SetupPrButton({
  repository,
  host,
  size = 'xs',
  variant = 'secondary',
  onError,
}: {
  repository: string
  host?: string // GHE 베이스 URL — 미지정 = github.com link
  size?: 'xs' | 'sm'
  variant?: 'secondary' | 'outline'
  onError?: (message: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [opened, setOpened] = useState<string>() // 방금 연 PR url

  function onClick() {
    startTransition(async () => {
      const r = await openSetupPrAction(repository, host)
      if (r.ok && r.prUrl) {
        setOpened(r.prUrl)
        window.open(r.prUrl, '_blank', 'noopener,noreferrer')
      } else onError?.(r.error ?? '셋업 PR 생성에 실패했습니다.')
    })
  }

  if (opened) {
    return (
      <a
        href={opened}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
      >
        <ExternalLink className="size-3.5" />
        열린 PR 보기
      </a>
    )
  }

  return (
    <Button size={size} variant={variant} disabled={pending} onClick={onClick}>
      <GitPullRequest />
      {pending ? '여는 중…' : '셋업 PR'}
    </Button>
  )
}
