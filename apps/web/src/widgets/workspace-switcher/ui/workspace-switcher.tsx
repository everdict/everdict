'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { Workspace } from '@/entities/workspace'
import { cn } from '@/shared/lib/utils'

// 이름의 첫 글자 모노그램(워크스페이스 아바타).
function monogram(name: string): string {
  const c = name.trim()[0]
  return (c ?? '?').toUpperCase()
}

// 사이드바 최상단 워크스페이스 스위처(Linear 컨벤션): 현재 워크스페이스 + 드롭다운으로 전환 + "새 워크스페이스".
// 계정/설정/로그아웃은 사이드바 하단 푸터가 담당한다(스위처와 역할 분리 → 칩 중복 제거).
export function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: string // 활성 워크스페이스 id
  workspaces: Workspace[]
}) {
  const t = useTranslations('workspaceSwitcher')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const active = workspaces.find((w) => w.id === current)
  const label = active?.name ?? current

  // 워크스페이스 전환 = 그 워크스페이스 홈으로 이동(URL 이 활성 워크스페이스의 권위; 미들웨어가 쿠키 동기화).
  // 리소스 상세(/runs/[id] 등)는 대상 워크스페이스에 없을 수 있어 개요로 이동한다.
  function select(id: string) {
    setOpen(false)
    if (id === current) return
    startTransition(() => {
      router.push(`/${id}`)
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card/60 px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/15 text-[15px] font-[560] text-primary ring-1 ring-inset ring-primary/25">
          {pending ? <Loader2 className="size-4 animate-spin" /> : monogram(label)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-[600] tracking-tight">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {active?.role ?? t('roleFallback')}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          {/* 바깥 클릭 닫기 */}
          <button
            type="button"
            aria-label={t('close')}
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-pop"
          >
            <p className="px-2 py-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('switchHeading')}
            </p>
            <div className="max-h-64 overflow-auto">
              {workspaces.length === 0 ? (
                <p className="px-2 py-1.5 text-[12px] text-muted-foreground">{t('empty')}</p>
              ) : (
                workspaces.map((w) => {
                  const isActive = w.id === current
                  return (
                    <button
                      key={w.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => select(w.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
                        isActive && 'bg-accent/60'
                      )}
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] font-[560] text-primary ring-1 ring-inset ring-primary/25">
                        {monogram(w.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{w.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {w.role}
                        </span>
                      </span>
                      {isActive && <Check className="size-4 shrink-0 text-primary" />}
                    </button>
                  )
                })
              )}
            </div>
            <div className="my-1 h-px bg-border" />
            <Link
              href="/new-workspace"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed border-border">
                <Plus className="size-3.5" />
              </span>
              {t('newWorkspace')}
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
