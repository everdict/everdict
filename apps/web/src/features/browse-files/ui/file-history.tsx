'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, ChevronDown, GitCompare, Loader2, MessageSquare, RotateCcw, User } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import type { FsActorView, FsRevisionDiffView, FsRevisionView } from '@/entities/workspace-file'
import { fmtBytes, fmtDateTimeFull, fmtSubject, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { EmptyState } from '@/shared/ui/empty-state'

import {
  diffRevisionsAction,
  listRevisionsAction,
  readRevisionAction,
  restoreRevisionAction,
} from '../api/browse-files'
import { languageFor } from '../lib/file-kind'
import { RevisionDiff } from './revision-diff'

const PAGE = 25 // a page of history; older revisions load on demand (the revision number is the cursor)

// postMessage `type` that opens a conversation in the shell's agent chat — pairs with widgets/infra-panel
// (OPEN_AGENT_SESSION_MESSAGE; a feature cannot import the widget, so keep the literal in sync, same as
// features/discuss). Posted to the parent when this renders inside the panel's iframe, else to our own window.
const OPEN_AGENT_SESSION = 'everdict:open-agent-session'

function openConversation(sessionId: string): void {
  if (typeof window === 'undefined') return
  const target = window.self !== window.top ? window.parent : window
  target.postMessage({ type: OPEN_AGENT_SESSION, sessionId }, window.location.origin)
}

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
  // One revision is expanded at a time, either as its CONTENT or as its DIFF against the live file — the two
  // readings of "what is this revision", chosen per row instead of forcing a mode on the whole panel.
  const [open, setOpen] = useState<{ revision: number; mode: 'content' | 'diff' } | undefined>(
    undefined
  )
  const [preview, setPreview] = useState<string | undefined>(undefined)
  const [diff, setDiff] = useState<FsRevisionDiffView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // Older pages exist while the last page came back full — the revision number is the cursor, so there is no
  // token to carry.
  const [exhausted, setExhausted] = useState(false)

  const load = useCallback(async () => {
    const res = await listRevisionsAction(path, { limit: PAGE })
    if (res.ok && res.data) {
      setRevisions(res.data)
      setExhausted(res.data.length < PAGE)
      setError(undefined)
    } else {
      setRevisions([])
      setExhausted(true)
      setError(res.error)
    }
  }, [path])

  useEffect(() => {
    setOpen(undefined)
    setPreview(undefined)
    setDiff(undefined)
    void load()
  }, [load])

  async function loadOlder() {
    const oldest = revisions?.at(-1)?.revision
    if (oldest === undefined || oldest <= 1) {
      setExhausted(true)
      return
    }
    setLoadingMore(true)
    const res = await listRevisionsAction(path, { limit: PAGE, before: oldest })
    setLoadingMore(false)
    if (!res.ok || !res.data) {
      setError(res.error)
      return
    }
    setRevisions((prev) => [...(prev ?? []), ...(res.data ?? [])])
    setExhausted(res.data.length < PAGE)
  }

  async function openRevision(revision: number) {
    if (open?.revision === revision && open.mode === 'content') return setOpen(undefined)
    setOpen({ revision, mode: 'content' })
    setPreview(undefined)
    const res = await readRevisionAction(path, revision)
    setPreview(res.ok && res.data ? res.data.content : (res.error ?? ''))
  }

  // Compare against the file as it stands now — the question a history row actually raises ("what did this
  // revision change from what I'm looking at?").
  async function compareRevision(revision: number) {
    if (open?.revision === revision && open.mode === 'diff') return setOpen(undefined)
    setOpen({ revision, mode: 'diff' })
    setDiff(undefined)
    const res = await diffRevisionsAction(path, revision)
    if (res.ok && res.data) setDiff(res.data)
    else setError(res.error)
  }

  async function restore(revision: number) {
    setBusy(true)
    const res = await restoreRevisionAction(path, revision)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setOpen(undefined)
    setPreview(undefined)
    setDiff(undefined)
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
                  open?.revision === rev.revision && open.mode === 'content'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground'
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
              <div className="ml-auto flex items-center gap-1">
                {/* Comparing the CURRENT revision against the live file would diff a thing against itself. */}
                {!isCurrent && (
                  <Button
                    variant={
                      open?.revision === rev.revision && open.mode === 'diff' ? 'outline' : 'ghost'
                    }
                    size="xs"
                    onClick={() => void compareRevision(rev.revision)}
                  >
                    <GitCompare /> {t('compare')}
                  </Button>
                )}
                {canWrite && !isCurrent && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => void restore(rev.revision)}
                  >
                    <RotateCcw /> {t('restore')}
                  </Button>
                )}
              </div>
            </div>
            {(rev.message !== undefined || rev.restoredFrom !== undefined) && (
              <p className="mt-1 text-[12px] text-muted-foreground">
                {rev.restoredFrom !== undefined
                  ? t('restoredFrom', { revision: rev.restoredFrom })
                  : rev.message}
              </p>
            )}
            {open?.revision === rev.revision && (
              <div className="mt-2">
                {open.mode === 'content' ? (
                  preview === undefined ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <CodeEditor
                      value={preview}
                      language={languageFor(path)}
                      minHeight="200px"
                      readOnly
                      aria-label={t('revisionLabel', { revision: rev.revision })}
                    />
                  )
                ) : diff === undefined ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <RevisionDiff result={diff} />
                )}
              </div>
            )}
          </div>
        )
      })}
      {!exhausted && (
        <div className="px-3.5 py-2">
          <Button variant="ghost" size="xs" disabled={loadingMore} onClick={() => void loadOlder()}>
            {loadingMore ? <Loader2 className="animate-spin" /> : <ChevronDown />} {t('loadOlder')}
          </Button>
        </div>
      )}
    </div>
  )
}

// Authorship in one line. An agent publish names the agent (falling back to its id) and stays visibly distinct
// from a member's own edit — that difference is the whole point of recording an actor rather than a subject.
// When the agent ran in a conversation, the line OPENS it: "why did this change?" is answered by the thread the
// work happened in, not by the file alone.
function ActorLine({ actor }: { actor: FsActorView }) {
  const t = useTranslations('files')
  if (actor.kind === 'agent') {
    const label = actor.agentName ?? actor.agentId ?? t('anAgent')
    const body = (
      <>
        <Bot className="size-3.5 text-primary" />
        {label}
        <span className="text-muted-foreground">
          {t('onBehalfOf', { subject: fmtSubject(actor.onBehalfOf ?? actor.subject) })}
        </span>
      </>
    )
    if (actor.conversationId === undefined) {
      return <span className="flex items-center gap-1 text-[12px] text-foreground">{body}</span>
    }
    return (
      <button
        type="button"
        onClick={() => openConversation(actor.conversationId ?? '')}
        title={t('openConversation')}
        className="flex items-center gap-1 rounded-md px-1 text-[12px] text-foreground hover:bg-accent"
      >
        {body}
        <MessageSquare className="size-3 text-muted-foreground" />
      </button>
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
