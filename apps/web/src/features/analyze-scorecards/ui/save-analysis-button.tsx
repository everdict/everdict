'use client'

import { useState, useTransition } from 'react'
import { BookmarkPlus, Check, Globe, Lock, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { View, ViewVisibility } from '@/entities/view'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

import { createViewAction, updateViewAction } from '../api/view-actions'
import { configToStored, type AnalysisConfig } from '../model/analysis'

// Keep what the conversation drew: save the canvas as a named View (private|workspace), or push it into the
// View that is already open. The ONLY member-side control left on the canvas — the analysis itself is shaped by
// talking to the agent, not by pickers. Listing / sharing / deleting saved views belongs to /views (the list).
export function SaveAnalysisButton({
  config,
  activeView,
  currentSubject,
  isAdmin = false,
}: {
  config: AnalysisConfig
  /** The saved View this canvas was opened from — its owner (or an admin) can push the current state into it. */
  activeView?: View
  currentSubject: string
  isAdmin?: boolean
}) {
  const t = useTranslations('analyzeScorecards')
  // The View this canvas is bound to — the one it opened from, or the one just saved from here.
  const [view, setView] = useState<View | undefined>(activeView)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<ViewVisibility>('private')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [pending, start] = useTransition()

  const canEditView = view && (isAdmin || view.createdBy === currentSubject) // control plane enforces finally

  const flash = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const create = () =>
    start(async () => {
      setError(undefined)
      const r = await createViewAction({
        name: name.trim(),
        config: configToStored(config),
        visibility,
      })
      if (!r.ok || !r.view) return setError(r.error ?? t('saveFailed'))
      setView(r.view)
      setNaming(false)
      setName('')
      setVisibility('private')
      flash()
    })

  const updateCurrent = () =>
    view &&
    start(async () => {
      setError(undefined)
      const r = await updateViewAction(view.id, { config: configToStored(config) })
      if (!r.ok || !r.view) return setError(r.error ?? t('updateFailed'))
      setView(r.view)
      flash()
    })

  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      {error && (
        <span className="inline-flex items-center gap-1 text-[12px] text-destructive">
          <X className="size-3.5" /> {error}
        </span>
      )}
      {saved && <span className="text-[12px] text-muted-foreground">{t('savedFlash')}</span>}

      {naming ? (
        <>
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
            onClick={create}
            disabled={pending || name.trim().length === 0}
          >
            <Check className="size-3.5" /> {t('save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setNaming(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
        </>
      ) : (
        <>
          {canEditView && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={updateCurrent}
              disabled={pending}
            >
              {t('updateToCurrent')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              setNaming(true)
              setError(undefined)
            }}
          >
            <BookmarkPlus className="size-3.5" /> {t('saveCurrent')}
          </Button>
        </>
      )}
    </div>
  )
}
