'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
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

// kind 별 톤 — 목록/상세에서 한눈에 구분되는 얇은 칩 색.
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

// 커버리지 배지 — current 는 무표시(신호 없음=조용). behind 는 "as-of 이전 버전"(틀림이 아니라 좌표),
// unverified 는 wall-clock 미확인 — 톤도 경보(빨강)가 아닌 중립(앰버 계열)로.
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
  if (refs.length === 0) return null // 빈 섹션은 통째로 숨김(detail-view 관례)
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

// 상세 다이얼로그 — 마크다운 본문 + 메타 스트립 + refs/evidence 칩 + (관리 가능 시) verify/edit/deprecate/delete.
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
  const router = useRouter()
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, startTransition] = useTransition()

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, close = false) =>
    startTransition(async () => {
      setError(undefined)
      const res = await fn()
      if (!res.ok) {
        setError(res.error ?? t('actionFailed'))
        return
      }
      router.refresh()
      if (close) onClose()
    })

  const behind = entry.coverage?.state === 'behind'

  // 구간 표기: "documented @2.1.0 · verified through 2.2.0 · current 2.3.0" — as-of 좌표를 그대로 보여준다.
  const gapLabel = (g: { ref: KnowledgePinView; latest: string }) => {
    const asOf = g.ref.version ? `@${g.ref.version}` : t('detail.unpinned')
    const through = g.ref.verifiedVersion ? ` → ${g.ref.verifiedVersion}` : ''
    return `${g.ref.type}:${g.ref.key} ${asOf}${through} · ${t('detail.currentVersion', { version: g.latest })}`
  }

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="space-y-4 p-5">
        <div className="space-y-2">
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

        {error && <p className="text-xs text-destructive">{error}</p>}

        {entry.status === 'proposed' && canReview && (
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
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
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
    </Dialog>
  )
}

// 워크스페이스 지식 브라우저 — kind 필터 + 목록 + 작성/상세 다이얼로그. 목록은 서버 컴포넌트가 내려준 props 가 SSOT
// (액션 후 router.refresh() 로 재조회 — 상세는 id 로 props 를 다시 읽으므로 자동 갱신).
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
