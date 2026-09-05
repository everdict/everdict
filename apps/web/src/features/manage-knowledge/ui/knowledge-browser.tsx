'use client'

import { useMemo, useState } from 'react'
import { BadgeCheck, History, Lock, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { FileHistory } from '@/features/browse-files'
import {
  KNOWLEDGE_ENTRY_KINDS,
  type KnowledgeCoverage,
  type KnowledgeEntry,
  type KnowledgePinView,
  type NodeRefView,
} from '@/entities/knowledge'
import { fmtDateTime } from '@/shared/lib/format'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Markdown } from '@/shared/ui/markdown'

import {
  approveKnowledgeEntryAction,
  deleteKnowledgeEntryAction,
  rejectKnowledgeEntryAction,
  updateKnowledgeEntryAction,
  verifyKnowledgeEntryAction,
} from '../api/manage-knowledge'
import { EntryFormDialog } from './entry-form-dialog'
import { ExtractKnowledgeButton } from '@/features/extract-knowledge'

// The tone per kind — a thin chip colour distinguishing them at a glance in the list and the detail.
const KIND_TONE: Record<KnowledgeEntry['kind'], string> = {
  finding: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  decision: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  convention: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  context: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
}

function KindChip({ kind }: { kind: KnowledgeEntry['kind'] }) {
  const t = useTranslations('knowledge')
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', KIND_TONE[kind])}>
      {t(`kinds.${kind}`)}
    </span>
  )
}

// The coverage badge — `current` is UNMARKED (no signal = quiet). `behind` means "as of an earlier version" (a coordinate, not a wrongness),
// and `unverified` means unconfirmed against the wall clock — so its tone is neutral (amber-ish) rather than an alarm (red).
function CoverageBadge({ coverage }: { coverage?: KnowledgeCoverage }) {
  const t = useTranslations('knowledge')
  if (!coverage || coverage.state === 'current') return null
  const behind = coverage.state === 'behind'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        behind
          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          : 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
      )}
    >
      <History className="size-3" />
      {behind ? t('coverage.behind') : t('coverage.unverified')}
    </span>
  )
}

const refLabel = (r: NodeRefView) => `${r.type}:${r.key}${r.version ? `@${r.version}` : ''}`

function RefChips({ label, refs }: { label: string; refs: NodeRefView[] }) {
  if (refs.length === 0) return null // an empty section is hidden entirely (the detail-view convention)
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {refs.map((r) => (
          <span key={refLabel(r)} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {refLabel(r)}
          </span>
        ))}
      </div>
    </div>
  )
}

// The detail dialog — the markdown body plus the meta strip plus refs/evidence chips plus (when manageable) verify/edit/deprecate/delete.
function EntryDetailDialog({
  entry,
  manageable,
  canReview,
  onClose,
  onEdit,
}: {
  entry: KnowledgeEntry
  manageable: boolean
  canReview: boolean
  onClose: () => void
  onEdit: () => void
}) {
  const t = useTranslations('knowledge')
  const f = useTranslations('files') // the body's file history speaks the Files vocabulary
  const refresh = useRefresh()
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState(false)

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, close = false) =>
    void (async () => {
      setPending(true)
      try {
        setError(undefined)
        const res = await fn()
        if (!res.ok) {
          setError(res.error ?? t('actionFailed'))
          return
        }
        refresh()
        if (close) onClose()
      } finally {
        setPending(false)
      }
    })()

  const behind = entry.coverage?.state === 'behind'

  // The interval notation: "documented @2.1.0 · verified through 2.2.0 · current 2.3.0" — the as-of coordinates shown as they are.
  const gapLabel = (g: { ref: KnowledgePinView; latest: string }) => {
    const asOf = g.ref.version ? `@${g.ref.version}` : t('detail.unpinned')
    const through = g.ref.verifiedVersion ? ` → ${g.ref.verifiedVersion}` : ''
    return `${g.ref.type}:${g.ref.key} ${asOf}${through} · ${t('detail.currentVersion', { version: g.latest })}`
  }

  const reviewable = entry.status === 'proposed' && canReview

  // The panel height is bound to the viewport (85vh) and only the BODY scrolls — stopping a long markdown entry from growing off screen and
  // being clipped by the Dialog's overflow-hidden. The title and meta are pinned at the top, the actions at the bottom.
  return (
    <Dialog open onClose={onClose} className="flex max-h-[85vh] max-w-2xl flex-col">
      <div className="shrink-0 space-y-2 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <KindChip kind={entry.kind} />
          <CoverageBadge coverage={entry.coverage} />
          {entry.visibility === 'private' && <Lock className="size-3.5 text-muted-foreground" />}
          {entry.status !== 'active' && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {t(`statuses.${entry.status}`)}
            </span>
          )}
        </div>
        <h2 className="text-base font-semibold">{entry.title}</h2>
        <p className="text-xs text-muted-foreground">
          {t('detail.meta', {
            by: entry.createdBy,
            updated: fmtDateTime(entry.updatedAt),
          })}
          {entry.verifiedAt &&
            ` · ${t('detail.verifiedAt', { at: fmtDateTime(entry.verifiedAt) })}`}
          {entry.extraction &&
            ` · ${t('detail.extractedFrom', {
              source: `${entry.extraction.sourceKind}:${entry.extraction.sourceId}`,
              confidence: Math.round(entry.extraction.confidence * 100),
            })}`}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {behind && entry.coverage && entry.coverage.gaps.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <p className="mb-1 font-medium text-amber-600 dark:text-amber-400">
              {t('detail.asOfTitle')}
            </p>
            <ul className="space-y-0.5 font-mono text-muted-foreground">
              {entry.coverage.gaps.map((g) => (
                <li key={refLabel(g.ref)}>{gapLabel(g)}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-muted-foreground">{t('detail.asOfHint')}</p>
          </div>
        )}

        <Markdown content={entry.body} className="text-sm" />

        {/* An entry's body IS a workspace file (knowledge/<id>.md — the content-projection SSOT), so it carries
            the same publication history as any other file: edits here, from the Files shell and by agents land
            in one list. Collapsed by default — the claim is what the reader came for; its provenance is a click
            away when they ask "who changed this, and why". */}
        <details className="group rounded-md border border-border">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
            <History className="mr-1.5 inline size-3.5" />
            {f('historyTitle')}
          </summary>
          <div className="border-t border-border">
            <FileHistory path={`knowledge/${entry.id}.md`} canWrite={manageable} />
          </div>
        </details>

        <RefChips label={t('detail.refs')} refs={entry.refs} />
        <RefChips label={t('detail.evidence')} refs={entry.evidence} />
      </div>

      {(error || reviewable || manageable) && (
        <div className="shrink-0 space-y-3 border-t border-border px-5 py-3">
          {error && <p className="text-xs text-destructive">{error}</p>}

          {reviewable && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-primary/25 bg-primary/5 p-3">
              <p className="text-xs text-muted-foreground">{t('detail.proposedHint')}</p>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => act(() => approveKnowledgeEntryAction(entry.id))}
                >
                  {t('detail.approve')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => act(() => rejectKnowledgeEntryAction(entry.id), true)}
                >
                  {t('detail.reject')}
                </Button>
              </div>
            </div>
          )}

          {manageable && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => act(() => verifyKnowledgeEntryAction(entry.id))}
              >
                <BadgeCheck className="size-4" /> {t('detail.verify')}
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={onEdit}>
                {t('detail.edit')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  act(() =>
                    updateKnowledgeEntryAction(entry.id, {
                      status: entry.status === 'active' ? 'deprecated' : 'active',
                    })
                  )
                }
              >
                {entry.status === 'active' ? t('detail.deprecate') : t('detail.reactivate')}
              </Button>
              <Button
                size="sm"
                variant={confirmDelete ? 'primary' : 'ghost'}
                disabled={pending}
                onClick={() =>
                  confirmDelete
                    ? act(() => deleteKnowledgeEntryAction(entry.id), true)
                    : setConfirmDelete(true)
                }
              >
                {confirmDelete ? t('detail.deleteConfirm') : t('detail.delete')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

// The workspace knowledge browser — a kind filter plus the list plus the create/detail dialogs. The list's SSOT is the props the server component
// passed down (re-queried with refresh() after an action — the detail re-reads its props by id, so it updates automatically).
export function KnowledgeBrowser({
  entries,
  canWrite,
  subject,
  isAdmin,
}: {
  entries: KnowledgeEntry[]
  canWrite: boolean
  subject: string
  isAdmin: boolean
}) {
  const t = useTranslations('knowledge')
  const [kindFilter, setKindFilter] = useState<KnowledgeEntry['kind'] | 'all'>('all')
  const [detailId, setDetailId] = useState<string | undefined>(undefined)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<KnowledgeEntry | undefined>(undefined)

  const filtered = useMemo(
    () => (kindFilter === 'all' ? entries : entries.filter((e) => e.kind === kindFilter)),
    [entries, kindFilter]
  )
  const detail = detailId !== undefined ? entries.find((e) => e.id === detailId) : undefined

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {(['all', ...KNOWLEDGE_ENTRY_KINDS] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={kindFilter === k ? 'primary' : 'secondary'}
              onClick={() => setKindFilter(k)}
            >
              {k === 'all' ? t('filters.all') : t(`kinds.${k}`)}
            </Button>
          ))}
        </div>
        {/* Mine a thread for CANDIDATES — proposed entries awaiting review, never published knowledge. It
            sits beside "new entry" because both end at the same review queue, from opposite directions. */}
        {canWrite && <ExtractKnowledgeButton />}
        {canWrite && (
          <Button
            size="sm"
            onClick={() => {
              setEditing(undefined)
              setFormOpen(true)
            }}
          >
            <Plus className="size-4" /> {t('newEntry')}
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={t('empty.title')} hint={t('empty.hint')} />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {filtered.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-accent/50"
                onClick={() => setDetailId(e.id)}
              >
                <KindChip kind={e.kind} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm',
                    e.status !== 'active' && 'text-muted-foreground line-through decoration-border'
                  )}
                >
                  {e.title}
                </span>
                <CoverageBadge coverage={e.coverage} />
                {e.visibility === 'private' && (
                  <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {fmtDateTime(e.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail && !formOpen && (
        <EntryDetailDialog
          entry={detail}
          manageable={canWrite && (isAdmin || detail.createdBy === subject)}
          canReview={canWrite}
          onClose={() => setDetailId(undefined)}
          onEdit={() => {
            setEditing(detail)
            setFormOpen(true)
          }}
        />
      )}

      <EntryFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        initial={editing}
        onSaved={(saved) => setDetailId(saved.id)}
      />
    </div>
  )
}
