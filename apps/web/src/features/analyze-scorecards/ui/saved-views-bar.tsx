'use client'

import { useState, useTransition } from 'react'
import { Bookmark, BookmarkPlus, Check, Globe, Link2, Lock, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { View, ViewVisibility } from '@/entities/view'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { createViewAction, deleteViewAction, updateViewAction } from '../api/view-actions'
import { configToStored, storedToConfig, type AnalysisConfig } from '../model/analysis'

// Saved-analysis View bar — save the current analysis under a name (private|shared), open a saved view for a live re-run, share/delete owned views.
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
  canManage: boolean // scorecards:run — can save/edit/delete (owned)
  isAdmin?: boolean // workspace admin — can also manage others' shared views
  activeViewId?: string
}) {
  const t = useTranslations('analyzeScorecards')
  const [views, setViews] = useState<View[]>(savedViews)
  const [activeId, setActiveId] = useState<string | undefined>(activeViewId)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<ViewVisibility>('private')
  const [error, setError] = useState<string | undefined>()
  const [pending, start] = useTransition()

  const activeView = views.find((v) => v.id === activeId)
  const ownsActive = activeView?.createdBy === currentSubject
  const canEditActive = canManage && (isAdmin || ownsActive) // owner or admin (control plane enforces finally)

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
      if (!r.ok || !r.view) return setError(r.error ?? t('saveFailed'))
      setViews((prev) => [r.view as View, ...prev])
      setActiveId(r.view.id)
      setSaving(false)
      setName('')
      setVisibility('private')
    })

  // Overwrite the active view with the current screen settings.
  const updateCurrent = () =>
    activeView &&
    start(async () => {
      setError(undefined)
      const r = await updateViewAction(activeView.id, { config: configToStored(config) })
      if (!r.ok || !r.view) return setError(r.error ?? t('updateFailed'))
      setViews((prev) => prev.map((v) => (v.id === r.view?.id ? (r.view as View) : v)))
    })

  const toggleVisibility = () =>
    activeView &&
    start(async () => {
      setError(undefined)
      const next: ViewVisibility = activeView.visibility === 'workspace' ? 'private' : 'workspace'
      const r = await updateViewAction(activeView.id, { visibility: next })
      if (!r.ok || !r.view) return setError(r.error ?? t('changeFailed'))
      setViews((prev) => prev.map((v) => (v.id === r.view?.id ? (r.view as View) : v)))
    })

  const remove = () =>
    activeView &&
    start(async () => {
      setError(undefined)
      const r = await deleteViewAction(activeView.id)
      if (!r.ok) return setError(r.error ?? t('deleteFailed'))
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
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <div className="space-y-2 rounded-lg border bg-card/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
          <Bookmark className="size-3.5" /> {t('savedViews')}
        </span>
        {views.length === 0 && <span className="text-[12px] text-faint">{t('noneYet')}</span>}
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
              title={mine ? t('myView') : t('sharedView')}
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
            <BookmarkPlus className="size-3.5" /> {t('saveCurrent')}
          </Button>
        )}
      </div>

      {/* save form */}
      {saving && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('viewNamePlaceholder')}
            className="w-[220px]"
            aria-label={t('viewNameAria')}
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
                {vis === 'private' ? t('private') : t('shared')}
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="xs"
            onClick={save}
            disabled={pending || name.trim().length === 0}
          >
            <Check className="size-3.5" /> {t('save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setSaving(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
        </div>
      )}

      {/* manage the active (owned) view */}
      {activeView && canEditActive && !saving && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-[12px]">
          <span className="text-faint">
            <span className="font-[510] text-muted-foreground">{activeView.name}</span>{' '}
            {t('manageSuffix')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={updateCurrent}
            disabled={pending}
          >
            {t('updateToCurrent')}
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
                <Lock className="size-3.5" /> {t('makePrivate')}
              </>
            ) : (
              <>
                <Globe className="size-3.5" /> {t('shareWorkspace')}
              </>
            )}
          </Button>
          {activeView.visibility === 'workspace' && (
            <Button type="button" variant="ghost" size="xs" onClick={copyLink}>
              <Link2 className="size-3.5" /> {t('link')}
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
            <Trash2 className="size-3.5" /> {t('delete')}
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
