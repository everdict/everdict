'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, Loader2, RotateCcw, User } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import type { FsActorView, FsRevisionView } from '@/entities/workspace-file'
import { fmtBytes, fmtDateTimeFull, fmtSubject, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { EmptyState } from '@/shared/ui/empty-state'

import { listRevisionsAction, readRevisionAction, restoreRevisionAction } from '../api/browse-files'
import { languageFor } from '../lib/file-kind'

// The file's publication history — the answer to "who changed this, and when". Members and agents both write
// these files, so the author line names the AGENT (and the conversation it ran in) when one published, rather
// than crediting the member who happened to ask. Selecting a revision previews its content; restoring publishes
// it again as a new revision, so a rollback is itself recorded instead of erasing what it replaced.
export function FileHistory({
  path,
  canWrite,
  currentRevision,
  onRestored,
}: {
  path: string
  canWrite: boolean
  currentRevision?: number
  onRestored?: () => void
}) {
  const t = useTranslations('files')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [revisions, setRevisions] = useState<FsRevisionView[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<number | undefined>(undefined)
  const [preview, setPreview] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await listRevisionsAction(path)
    if (res.ok && res.data) {
      setRevisions(res.data)
      setError(undefined)
    } else {
      setRevisions([])
      setError(res.error)
    }
  }, [path])

  useEffect(() => {
    setSelected(undefined)
    setPreview(undefined)
    void load()
  }, [load])

  async function openRevision(revision: number) {
    setSelected(revision)
    setPreview(undefined)
    const res = await readRevisionAction(path, revision)
    setPreview(res.ok && res.data ? res.data.content : (res.error ?? ''))
  }

  async function restore(revision: number) {
    setBusy(true)
    const res = await restoreRevisionAction(path, revision)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setSelected(undefined)
    setPreview(undefined)
    await load()
    onRestored?.()
  }

  if (revisions === undefined) {
    return (
      <div className="flex items-center gap-2 p-3.5 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }
  if (revisions.length === 0) {
    return (
      <div className="p-3.5">
        <EmptyState title={t('noHistoryTitle')} hint={error ?? t('noHistoryHint')} />
      </div>
    )
  }

  return (
    <div className="divide-y divide-border">
      {revisions.map((rev) => {
        const isCurrent = rev.revision === (currentRevision ?? revisions[0]?.revision)
        return (
          <div key={rev.revision} className="px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <button
                type="button"
                onClick={() => void openRevision(rev.revision)}
                className={cn(
                  'rounded-md px-1.5 py-0.5 font-mono text-[11.5px] hover:bg-accent',
                  selected === rev.revision ? 'bg-accent text-foreground' : 'text-muted-foreground'
                )}
              >
                {t('revisionLabel', { revision: rev.revision })}
              </button>
              {isCurrent && (
                <span className="rounded-full border border-primary/30 bg-primary/8 px-1.5 py-0.5 text-[10.5px] text-primary">
                  {t('currentRevision')}
                </span>
              )}
              <ActorLine actor={rev.actor} />
              <span
                className="text-[11.5px] text-muted-foreground"
                title={fmtDateTimeFull(rev.createdAt, { locale, timeZone })}
              >
                {fmtTimeAgo(rev.createdAt, locale, timeZone)}
              </span>
              <span className="text-[11px] text-muted-foreground/70">{fmtBytes(rev.size)}</span>
              {canWrite && !isCurrent && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void restore(rev.revision)}
                >
                  <RotateCcw /> {t('restore')}
                </Button>
              )}
            </div>
            {(rev.message !== undefined || rev.restoredFrom !== undefined) && (
              <p className="mt-1 text-[12px] text-muted-foreground">
                {rev.restoredFrom !== undefined
                  ? t('restoredFrom', { revision: rev.restoredFrom })
                  : rev.message}
              </p>
            )}
            {selected === rev.revision && (
              <div className="mt-2">
                {preview === undefined ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <CodeEditor
                    value={preview}
                    language={languageFor(path)}
                    minHeight="200px"
                    readOnly
                    aria-label={t('revisionLabel', { revision: rev.revision })}
                  />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Authorship in one line. An agent publish names the agent (falling back to its id) and stays visibly distinct
// from a member's own edit — that difference is the whole point of recording an actor rather than a subject.
function ActorLine({ actor }: { actor: FsActorView }) {
  const t = useTranslations('files')
  if (actor.kind === 'agent') {
    return (
      <span className="flex items-center gap-1 text-[12px] text-foreground">
        <Bot className="size-3.5 text-primary" />
        {actor.agentName ?? actor.agentId ?? t('anAgent')}
        <span className="text-muted-foreground">
          {t('onBehalfOf', { subject: fmtSubject(actor.onBehalfOf ?? actor.subject) })}
        </span>
      </span>
    )
  }
  if (actor.kind === 'system') {
    return <span className="text-[12px] text-muted-foreground">{t('systemActor')}</span>
  }
  return (
    <span className="flex items-center gap-1 text-[12px] text-foreground">
      <User className="size-3.5 text-muted-foreground" />
      {fmtSubject(actor.subject)}
    </span>
  )
}
