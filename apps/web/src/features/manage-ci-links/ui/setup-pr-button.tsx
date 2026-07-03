'use client'

import { useState, useTransition } from 'react'
import { ExternalLink, GitPullRequest } from 'lucide-react'

import type { ConnectionMeta } from '@/entities/connection'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'

import { openSetupPrAction } from '../api/manage-ci-links'

// 셋업 PR 열기 — link 의 워크플로 YAML 을 대상 레포에 PR(내 GitHub 연결 토큰). 연결이 여럿이면 어느 연결로 열지 고른다.
// 연결이 없으면 비활성(계정 페이지에서 GitHub 연결 필요). 성공 시 새 탭으로 PR 을 연다.
export function SetupPrButton({
  repository,
  connections,
  size = 'xs',
  variant = 'secondary',
  onError,
}: {
  repository: string
  connections: ConnectionMeta[] // github | github-enterprise 로 이미 필터된 목록
  size?: 'xs' | 'sm'
  variant?: 'secondary' | 'outline'
  onError?: (message: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [picking, setPicking] = useState(false)
  const [opened, setOpened] = useState<string>() // 방금 연 PR url

  function fire(connectionId: string) {
    setPicking(false)
    startTransition(async () => {
      const r = await openSetupPrAction(repository, connectionId)
      if (r.ok && r.prUrl) {
        setOpened(r.prUrl)
        window.open(r.prUrl, '_blank', 'noopener,noreferrer')
      } else onError?.(r.error ?? '셋업 PR 생성에 실패했습니다.')
    })
  }

  function onClick() {
    if (connections.length === 1 && connections[0]) fire(connections[0].id)
    else setPicking((v) => !v)
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

  if (connections.length === 0) {
    return (
      <span
        className="cursor-not-allowed text-[12px] text-muted-foreground"
        title="GitHub 연결이 필요합니다(계정 → 연결된 계정)."
      >
        셋업 PR — GitHub 연결 필요
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size={size} variant={variant} disabled={pending} onClick={onClick}>
        <GitPullRequest />
        {pending ? '여는 중…' : '셋업 PR'}
      </Button>
      {picking && connections.length > 1 && (
        <Combobox
          options={connections.map((c) => ({
            value: c.id,
            label: c.accountLabel,
            hint: c.provider,
          }))}
          value=""
          onChange={fire}
          placeholder="연결 선택"
          align="end"
          className="w-44"
        />
      )}
    </span>
  )
}
