'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Loader2, Plus } from 'lucide-react'

import { switchWorkspaceAction } from '@/features/switch-workspace'
import type { Workspace } from '@/entities/workspace'
import { cn } from '@/shared/lib/utils'

// 이름의 첫 글자 모노그램(워크스페이스 아바타). Linear st. — 인디고 톤.
function monogram(name: string): string {
  const c = name.trim()[0]
  return (c ?? '?').toUpperCase()
}

// 사이드바 최상단 워크스페이스 스위처(Linear 컨벤션): 현재 워크스페이스 + 드롭다운으로 전환 + "새 워크스페이스".
export function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: string // 활성 워크스페이스 id
  workspaces: Workspace[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const active = workspaces.find((w) => w.id === current)
  const label = active?.name ?? current

  function select(id: string) {
    setOpen(false)
    if (id === current) return
    startTransition(async () => {
      await switchWorkspaceAction(id)
      router.refresh()
    })
  }

  return (
    <div className="relative mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border/70 bg-card/60 px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/15 text-[13px] font-semibold text-primary ring-1 ring-inset ring-primary/25">
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : monogram(label)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold tracking-tight">{label}</span>
          {active ? (
            <span className="block truncate text-[11px] text-muted-foreground">{active.role}</span>
          ) : (
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {current}
            </span>
          )}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          {/* 바깥 클릭 닫기 */}
          <button
            type="button"
            aria-label="닫기"
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="listbox"
            className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-[0_12px_32px_-12px_rgba(8,9,10,0.45)]"
          >
            <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              워크스페이스
            </p>
            <div className="max-h-64 overflow-auto">
              {workspaces.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  아직 워크스페이스가 없습니다.
                </p>
              ) : (
                workspaces.map((w) => {
                  const isActive = w.id === current
                  return (
                    <button
                      key={w.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => select(w.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent',
                        isActive && 'bg-accent/60'
                      )}
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] font-semibold text-primary ring-1 ring-inset ring-primary/25">
                        {monogram(w.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{w.name}</span>
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
              href="/dashboard/workspaces/new"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed border-border">
                <Plus className="size-3.5" />
              </span>
              새 워크스페이스
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
