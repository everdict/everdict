'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Globe, Lock, MoreHorizontal, Trash2 } from 'lucide-react'

import type { View } from '@/entities/view'
import { fmtTimeAgo } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { Tooltip } from '@/shared/ui/tooltip'

import { deleteViewAction, updateViewAction } from '../api/view-actions'
import { describeConfig, storedToConfig } from '../model/analysis'

type Author = { name: string; avatarUrl?: string }

// 저장된 분석 View 목록(1급 객체) — 카드마다 구성 요약 + 가시성 + 소유자, 열기=라이브 재실행, 소유자·admin 은 공유토글/삭제.
export function ViewList({
  views,
  authors,
  currentSubject,
  isAdmin,
  workspace,
}: {
  views: View[]
  authors: Record<string, Author>
  currentSubject: string
  isAdmin: boolean
  workspace: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | undefined>()

  const ownerName = (subject: string) =>
    `${authors[subject]?.name ?? subject}${subject === currentSubject ? ' (나)' : ''}`

  const toggleVisibility = (v: View) =>
    start(async () => {
      setError(undefined)
      const next = v.visibility === 'workspace' ? 'private' : 'workspace'
      const r = await updateViewAction(v.id, { visibility: next })
      if (!r.ok) return setError(r.error ?? '변경하지 못했어요.')
      router.refresh()
    })

  const remove = (v: View) =>
    start(async () => {
      setError(undefined)
      const r = await deleteViewAction(v.id)
      if (!r.ok) return setError(r.error ?? '삭제하지 못했어요.')
      router.refresh()
    })

  return (
    <div className="space-y-2">
      {error && <p className="text-[12px] text-destructive">{error}</p>}
      {views.map((v) => {
        const chips = describeConfig(storedToConfig(v.config))
        const canEdit = isAdmin || v.createdBy === currentSubject
        return (
          <div
            key={v.id}
            className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-raise transition-colors hover:border-border-strong"
          >
            <Link
              href={`/${workspace}/views/${encodeURIComponent(v.id)}`}
              className="min-w-0 flex-1"
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-[560] text-foreground">{v.name}</span>
                <Badge tone={v.visibility === 'workspace' ? 'info' : 'neutral'}>
                  {v.visibility === 'workspace' ? (
                    <>
                      <Globe className="size-3" /> 공유
                    </>
                  ) : (
                    <>
                      <Lock className="size-3" /> 비공개
                    </>
                  )}
                </Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {chips.map((c, i) => (
                  <span
                    key={i}
                    className="rounded bg-secondary/60 px-1.5 py-0.5 text-[11px] font-[510] text-muted-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </Link>

            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden text-[11px] text-faint sm:inline">
                {fmtTimeAgo(v.updatedAt)} 수정
              </span>
              <span className="flex w-7 justify-center">
                <UserAvatar
                  name={ownerName(v.createdBy)}
                  url={authors[v.createdBy]?.avatarUrl}
                  label="소유자"
                />
              </span>
              <span className="flex w-8 justify-center">
                {canEdit ? (
                  <DropdownMenu
                    align="end"
                    trigger={({ open, toggle }) => (
                      <button
                        type="button"
                        onClick={toggle}
                        disabled={pending}
                        aria-label="뷰 메뉴"
                        aria-expanded={open}
                        className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    )}
                  >
                    <DropdownItem
                      icon={v.visibility === 'workspace' ? <Lock /> : <Globe />}
                      onSelect={() => toggleVisibility(v)}
                    >
                      {v.visibility === 'workspace' ? '비공개로 전환' : '워크스페이스 공유'}
                    </DropdownItem>
                    <DropdownSeparator />
                    <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => remove(v)}>
                      삭제
                    </DropdownItem>
                  </DropdownMenu>
                ) : (
                  <Tooltip content="공유 뷰 — 소유자만 관리" align="end">
                    <span className="grid size-8 place-items-center text-faint">
                      <Globe className="size-4" />
                    </span>
                  </Tooltip>
                )}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
