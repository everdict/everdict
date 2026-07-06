'use client'

import { useState, useTransition } from 'react'
import { Bookmark, BookmarkPlus, Check, Globe, Link2, Lock, Trash2, X } from 'lucide-react'

import type { View, ViewVisibility } from '@/entities/view'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { createViewAction, deleteViewAction, updateViewAction } from '../api/view-actions'
import { configToStored, storedToConfig, type AnalysisConfig } from '../model/analysis'

// 저장된 분석 View 바 — 현재 분석을 이름 붙여 저장(비공개|공유), 저장된 뷰를 열어 라이브 재실행, 소유 뷰 공유/삭제.
export function SavedViewsBar({
  config,
  onLoad,
  savedViews,
  currentSubject,
  canManage,
  isAdmin = false,
  activeViewId,
}: {
  config: AnalysisConfig
  onLoad: (config: AnalysisConfig) => void
  savedViews: View[]
  currentSubject: string
  canManage: boolean // scorecards:run — 저장·수정·삭제(소유) 가능
  isAdmin?: boolean // 워크스페이스 admin — 남의 공유 뷰도 관리
  activeViewId?: string
}) {
  const [views, setViews] = useState<View[]>(savedViews)
  const [activeId, setActiveId] = useState<string | undefined>(activeViewId)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<ViewVisibility>('private')
  const [error, setError] = useState<string | undefined>()
  const [pending, start] = useTransition()

  const activeView = views.find((v) => v.id === activeId)
  const ownsActive = activeView?.createdBy === currentSubject
  const canEditActive = canManage && (isAdmin || ownsActive) // 소유자 또는 admin(컨트롤플레인이 최종 강제)

  const load = (v: View) => {
    onLoad(storedToConfig(v.config))
    setActiveId(v.id)
    setSaving(false)
    setError(undefined)
  }

  const save = () =>
    start(async () => {
      setError(undefined)
      const r = await createViewAction({
        name: name.trim(),
        config: configToStored(config),
        visibility,
      })
      if (!r.ok || !r.view) return setError(r.error ?? '저장하지 못했어요.')
      setViews((prev) => [r.view as View, ...prev])
      setActiveId(r.view.id)
      setSaving(false)
      setName('')
      setVisibility('private')
    })

  // 활성 뷰를 현재 화면 설정으로 덮어쓰기.
  const updateCurrent = () =>
    activeView &&
    start(async () => {
      setError(undefined)
      const r = await updateViewAction(activeView.id, { config: configToStored(config) })
      if (!r.ok || !r.view) return setError(r.error ?? '수정하지 못했어요.')
      setViews((prev) => prev.map((v) => (v.id === r.view?.id ? (r.view as View) : v)))
    })

  const toggleVisibility = () =>
    activeView &&
    start(async () => {
      setError(undefined)
      const next: ViewVisibility = activeView.visibility === 'workspace' ? 'private' : 'workspace'
      const r = await updateViewAction(activeView.id, { visibility: next })
      if (!r.ok || !r.view) return setError(r.error ?? '변경하지 못했어요.')
      setViews((prev) => prev.map((v) => (v.id === r.view?.id ? (r.view as View) : v)))
    })

  const remove = () =>
    activeView &&
    start(async () => {
      setError(undefined)
      const r = await deleteViewAction(activeView.id)
      if (!r.ok) return setError(r.error ?? '삭제하지 못했어요.')
      setViews((prev) => prev.filter((v) => v.id !== activeView.id))
      setActiveId(undefined)
    })

  const copyLink = async () => {
    if (!activeView) return
    try {
      const url = new URL(window.location.href)
      url.search = `?view=${encodeURIComponent(activeView.id)}`
      await navigator.clipboard.writeText(url.toString())
    } catch {
      /* clipboard 불가 — 무시 */
    }
  }

  return (
    <div className="space-y-2 rounded-lg border bg-card/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
          <Bookmark className="size-3.5" /> 저장된 뷰
        </span>
        {views.length === 0 && <span className="text-[12px] text-faint">아직 없어요</span>}
        {views.map((v) => {
          const mine = v.createdBy === currentSubject
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => load(v)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-[510] transition-colors',
                v.id === activeId
                  ? 'border-primary/60 bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground'
              )}
              title={mine ? '내 뷰' : '워크스페이스 공유 뷰'}
            >
              {v.visibility === 'workspace' ? (
                <Globe className="size-3 text-faint" />
              ) : (
                <Lock className="size-3 text-faint" />
              )}
              {v.name}
            </button>
          )
        })}
        {canManage && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={() => {
              setSaving((s) => !s)
              setError(undefined)
            }}
          >
            <BookmarkPlus className="size-3.5" /> 현재 분석 저장
          </Button>
        )}
      </div>

      {/* 저장 폼 */}
      {saving && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="뷰 이름 (예: 나이트 회귀 추이)"
            className="w-[220px]"
            aria-label="뷰 이름"
            autoFocus
          />
          <div className="inline-flex overflow-hidden rounded-md border bg-card">
            {(['private', 'workspace'] as ViewVisibility[]).map((vis, i) => (
              <button
                key={vis}
                type="button"
                onClick={() => setVisibility(vis)}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-[510] transition-colors',
                  i > 0 && 'border-l border-border',
                  visibility === vis
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {vis === 'private' ? <Lock className="size-3" /> : <Globe className="size-3" />}
                {vis === 'private' ? '비공개' : '공유'}
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="xs"
            onClick={save}
            disabled={pending || name.trim().length === 0}
          >
            <Check className="size-3.5" /> 저장
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setSaving(false)}
            disabled={pending}
          >
            취소
          </Button>
        </div>
      )}

      {/* 활성(소유) 뷰 관리 */}
      {activeView && canEditActive && !saving && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-[12px]">
          <span className="text-faint">
            <span className="font-[510] text-muted-foreground">{activeView.name}</span> 관리
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={updateCurrent}
            disabled={pending}
          >
            현재 상태로 업데이트
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={toggleVisibility}
            disabled={pending}
          >
            {activeView.visibility === 'workspace' ? (
              <>
                <Lock className="size-3.5" /> 비공개로
              </>
            ) : (
              <>
                <Globe className="size-3.5" /> 워크스페이스 공유
              </>
            )}
          </Button>
          {activeView.visibility === 'workspace' && (
            <Button type="button" variant="ghost" size="xs" onClick={copyLink}>
              <Link2 className="size-3.5" /> 링크
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-destructive hover:text-destructive"
            onClick={remove}
            disabled={pending}
          >
            <Trash2 className="size-3.5" /> 삭제
          </Button>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1 border-t border-border/60 pt-2 text-[12px] text-destructive">
          <X className="size-3.5" /> {error}
        </p>
      )}
    </div>
  )
}
