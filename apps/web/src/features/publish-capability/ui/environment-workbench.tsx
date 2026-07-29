'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  ArrowUpRight,
  ChevronRight,
  Container,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Trash2,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Capability } from '@/entities/capability'
import type { AdoptedEnvironment } from '@/entities/environment-adoption'
import { fmtDateTime, fmtSubject } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'
import { Tooltip } from '@/shared/ui/tooltip'

import { unadoptEnvironmentAction, verifyAdoptedEnvironmentAction } from '../api/adopt-environment'
import { deleteCapabilityVersionAction } from '../api/manage-capabilities'
import { EnvironmentEditor } from './environment-editor'
import { ReachDialog } from './reach-controls'

// 하나의 행 = 하나의 환경 정체성(source/id) — 이 워크스페이스가 저작한 것과 스토어에서 가져온 것을
// 한 목록·한 어휘로 합친다(멘탈 모델 = "우리 워크스페이스가 쓸 수 있는 환경들").
type EnvironmentRow = {
  key: string
  capability?: Capability
  inventory?: AdoptedEnvironment
}

type Scope = 'all' | 'authored' | 'imported'

// Settings › Environments 의 환경 전용 표면 — 스토어 크롬(채택 통계·kind 필터·발행 어휘) 없이
// 등록/공유/검증/소비 준비 상태를 환경의 언어로 관리한다. 발견·가져오기는 스토어가 담당(우상단 링크).
export function EnvironmentWorkbench({
  authored,
  imported,
  authors,
  currentWorkspace,
  currentSubject,
  isAdmin,
  canWrite,
  canImport,
  canPublishPublic,
  myWorkspaces,
  imageRegistries,
}: {
  authored: Capability[]
  imported: AdoptedEnvironment[]
  authors: Record<string, { name: string; avatarUrl?: string }>
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  canWrite: boolean
  canImport: boolean
  canPublishPublic: boolean
  myWorkspaces: { id: string; name: string }[]
  imageRegistries: { name: string; host: string }[]
}) {
  const t = useTranslations('capabilityStore')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<Capability | 'new' | null>(null)
  const [reaching, setReaching] = useState<Capability | null>(null)
  const [confirming, setConfirming] = useState<Capability | null>(null)
  const [pending, startTransition] = useTransition()

  const rows = useMemo<EnvironmentRow[]>(() => {
    const inventoryByKey = new Map(imported.map((e) => [`${e.source}/${e.id}`, e]))
    const merged: EnvironmentRow[] = authored.map((c) => {
      const key = `${c.tenant}/${c.id}`
      const inventory = inventoryByKey.get(key)
      return { key, capability: c, ...(inventory !== undefined ? { inventory } : {}) }
    })
    const authoredKeys = new Set(merged.map((r) => r.key))
    for (const e of imported) {
      const key = `${e.source}/${e.id}`
      if (!authoredKeys.has(key)) merged.push({ key, inventory: e })
    }
    return merged.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  }, [authored, imported])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (scope === 'authored' && row.capability === undefined) return false
      if (scope === 'imported' && row.inventory === undefined) return false
      if (q.length === 0) return true
      const spec = row.capability?.spec.type === 'environment' ? row.capability.spec : undefined
      const haystack = [
        nameOf(row),
        row.key,
        spec?.image ?? row.inventory?.image ?? '',
        spec?.contents?.benchmark ?? row.inventory?.benchmark ?? '',
        ...(row.capability?.tags ?? []),
      ]
      return haystack.some((v) => v.toLowerCase().includes(q))
    })
  }, [rows, query, scope])

  const canManage = (c: Capability) => canWrite && (c.createdBy === currentSubject || isAdmin)

  const reverify = (e: AdoptedEnvironment) =>
    startTransition(async () => {
      const r = await verifyAdoptedEnvironmentAction(e.source, e.id)
      if (!r.ok) toast.error(r.error ?? t('reverifyError'))
      else if (r.environment.verify?.pullable === false)
        toast.warning(t('importedNotPullable', { name: e.name ?? e.id }))
      else toast.success(t('reverified'))
    })
  const removeFromInventory = (e: AdoptedEnvironment) =>
    startTransition(async () => {
      const r = await unadoptEnvironmentAction(e.source, e.id)
      if (r.ok) toast.success(t('unimported', { name: e.name ?? e.id }))
      else toast.error(r.error ?? t('unimportError'))
    })
  const del = (c: Capability) =>
    startTransition(async () => {
      const r = await deleteCapabilityVersionAction(c.id, c.version)
      if (r.ok) toast.success(t('deleted', { name: c.name }))
      else toast.error(r.error ?? t('deleteError'))
      setConfirming(null)
    })

  const scopes: { value: Scope; label: string }[] = [
    { value: 'all', label: t('envScopeAll') },
    { value: 'authored', label: t('envScopeAuthored') },
    { value: 'imported', label: t('envScopeImported') },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('envSearchPlaceholder')}
            className="pl-8"
            aria-label={t('envSearchPlaceholder')}
          />
        </div>
        <div className="flex rounded-md ring-1 ring-inset ring-border">
          {scopes.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setScope(s.value)}
              className={cn(
                'px-2.5 py-1.5 text-[12.5px] font-medium transition-colors first:rounded-l-md last:rounded-r-md',
                scope === s.value
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <Link
          href={`/${currentWorkspace}/store`}
          className="inline-flex items-center gap-1 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('envFindInStore')}
          <ArrowUpRight className="size-3.5" />
        </Link>
        {canWrite && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus />
            {t('envRegister')}
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Container />}
          title={t('envEmptyTitle')}
          hint={t('envEmptyHint')}
          {...(canWrite
            ? { action: <Button onClick={() => setEditing('new')}>{t('envRegister')}</Button> }
            : {})}
        />
      ) : list.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">{t('envNoMatches')}</p>
      ) : (
        <div className="space-y-2">
          {list.map((row) => (
            <EnvironmentRowCard
              key={row.key}
              row={row}
              expanded={expanded === row.key}
              onToggle={() => setExpanded((k) => (k === row.key ? null : row.key))}
              authors={authors}
              currentWorkspace={currentWorkspace}
              canManage={row.capability !== undefined && canManage(row.capability)}
              canImport={canImport}
              pending={pending}
              onEdit={() => row.capability !== undefined && setEditing(row.capability)}
              onReach={() => row.capability !== undefined && setReaching(row.capability)}
              onDelete={() => row.capability !== undefined && setConfirming(row.capability)}
              onReverify={() => row.inventory !== undefined && reverify(row.inventory)}
              onRemove={() => row.inventory !== undefined && removeFromInventory(row.inventory)}
            />
          ))}
        </div>
      )}

      {editing !== null && (
        <EnvironmentEditor
          capability={editing === 'new' ? null : editing}
          myWorkspaces={myWorkspaces}
          imageRegistries={imageRegistries}
          ownerId={currentWorkspace}
          canPublishPublic={canPublishPublic}
          onClose={() => setEditing(null)}
        />
      )}

      {reaching !== null && (
        <ReachDialog
          capability={reaching}
          canPublishPublic={canPublishPublic}
          myWorkspaces={myWorkspaces}
          onClose={() => setReaching(null)}
        />
      )}

      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} className="max-w-sm">
        <div className="space-y-4 p-5">
          <div>
            <h3 className="text-sm font-medium">{t('deleteTitle')}</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t('deleteConfirm', {
                name: confirming?.name ?? '',
                version: confirming?.version ?? '',
              })}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => confirming && del(confirming)}
              disabled={pending}
            >
              {t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

const nameOf = (row: EnvironmentRow): string =>
  row.capability?.name ?? row.inventory?.name ?? row.inventory?.id ?? row.key

// pull 불가 사유 배지 문구 — verify.reason 별(권한/없음/레지스트리 불통), 사유 없이 불가면 일반 "풀 불가".
function pullReasonLabel(
  t: (key: string) => string,
  reason: 'ok' | 'auth' | 'not-found' | 'unreachable' | undefined
): string {
  if (reason === 'auth') return t('verifyAuth')
  if (reason === 'not-found') return t('verifyNotFound')
  if (reason === 'unreachable') return t('verifyUnreachable')
  return t('importedNotPullableBadge')
}

function EnvironmentRowCard({
  row,
  expanded,
  onToggle,
  authors,
  currentWorkspace,
  canManage,
  canImport,
  pending,
  onEdit,
  onReach,
  onDelete,
  onReverify,
  onRemove,
}: {
  row: EnvironmentRow
  expanded: boolean
  onToggle: () => void
  authors: Record<string, { name: string; avatarUrl?: string }>
  currentWorkspace: string
  canManage: boolean
  canImport: boolean
  pending: boolean
  onEdit: () => void
  onReach: () => void
  onDelete: () => void
  onReverify: () => void
  onRemove: () => void
}) {
  const t = useTranslations('capabilityStore')
  const c = row.capability
  const spec = c?.spec.type === 'environment' ? c.spec : undefined
  const inv = row.inventory
  const image = spec?.image ?? inv?.image
  const benchmark = spec?.contents?.benchmark ?? inv?.benchmark
  const version = c?.version ?? inv?.version
  const author = c !== undefined ? authors[c.createdBy] : undefined
  // pull 자격 실패(auth)만 인라인 해결 경로를 붙인다 — 해법이 이 화면 밖(통합 설정의 레지스트리 등록)에 있기 때문.
  const needsRegistryFix = inv?.verify?.pullable === false && inv.verify.reason === 'auth'

  return (
    <div className="rounded-lg border border-border bg-card shadow-raise">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        aria-expanded={expanded}
        className="group flex w-full cursor-pointer items-center gap-3 px-4 py-3 outline-none"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-faint transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
          <Container className="size-[18px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-[560]">{nameOf(row)}</span>
            {benchmark !== undefined && benchmark.length > 0 && (
              <Badge tone="outline" className="shrink-0">
                {benchmark}
              </Badge>
            )}
            {c !== undefined && (
              <Badge tone={c.visibility === 'private' ? 'outline' : 'info'} className="shrink-0">
                {t(`vis_${c.visibility}`)}
              </Badge>
            )}
            {c === undefined && inv !== undefined && (
              <Badge tone="neutral" className="shrink-0">
                {t('importedBadge')}
              </Badge>
            )}
            {inv !== undefined && !inv.available && (
              <Badge tone="danger" className="shrink-0">
                {t('envUnavailable')}
              </Badge>
            )}
            {inv?.verify !== undefined &&
              (inv.verify.pullable ? (
                <Badge tone="success" className="shrink-0">
                  {t('pullableBadge')}
                </Badge>
              ) : (
                <Badge tone="warning" className="shrink-0">
                  {pullReasonLabel(t, inv.verify.reason)}
                </Badge>
              ))}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
            {image ?? row.key}
            {version !== undefined ? ` · ${version}` : ''}
          </div>
        </div>

        {/* 우측 액션 — 행 클릭(펼침)으로 버블링되지 않게 막는다. */}
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {needsRegistryFix && (
            <Tooltip content={t('envRegistryFixTip')} side="top" align="end">
              <Link
                href={`/${currentWorkspace}/settings/integrations`}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground ring-1 ring-inset ring-border transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('envRegistryFix')}
                <ArrowUpRight className="size-3" />
              </Link>
            </Tooltip>
          )}
          {inv !== undefined && canImport && (
            <>
              <Button variant="ghost" size="sm" disabled={pending} onClick={onReverify}>
                <RefreshCw />
                {t('reverify')}
              </Button>
              {c === undefined && (
                <Button variant="ghost" size="sm" disabled={pending} onClick={onRemove}>
                  <Trash2 />
                  {t('inventoryRemove')}
                </Button>
              )}
            </>
          )}
          {c !== undefined && canManage && (
            <DropdownMenu
              align="end"
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  disabled={pending}
                  aria-label={t('menu')}
                  aria-expanded={open}
                  className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              )}
            >
              <DropdownItem icon={<Pencil />} onSelect={onEdit}>
                {t('edit')}
              </DropdownItem>
              <DropdownItem icon={<Share2 />} onSelect={onReach}>
                {t('changeReach')}
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
                {t('delete')}
              </DropdownItem>
            </DropdownMenu>
          )}
          {author !== undefined && (
            <Avatar name={author.name} url={author.avatarUrl} size="sm" className="rounded-full" />
          )}
          {c !== undefined && author === undefined && (
            <span className="text-[11.5px] text-faint">{fmtSubject(c.createdBy)}</span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border px-4 py-3.5">
          {c !== undefined && c.description.length > 0 && (
            <p className="text-[12.5px] text-muted-foreground">{c.description}</p>
          )}
          {spec !== undefined && (spec.contents?.packages.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {spec.contents?.packages.map((p) => (
                <Badge key={p} tone="neutral" className="font-mono">
                  {p}
                </Badge>
              ))}
              {spec.contents?.os !== undefined && <Badge tone="outline">{spec.contents.os}</Badge>}
              {spec.contents?.arch !== undefined && (
                <Badge tone="outline">{spec.contents.arch}</Badge>
              )}
            </div>
          )}
          {spec !== undefined && spec.instructions.trim().length > 0 && (
            <div>
              <p className="text-[11px] font-[510] text-muted-foreground">{t('envInstructions')}</p>
              <Markdown
                content={spec.instructions}
                className="mt-1 text-[12.5px] leading-relaxed"
              />
            </div>
          )}
          {spec?.preset !== undefined && (
            <div>
              <p className="text-[11px] font-[510] text-muted-foreground">{t('envPreset')}</p>
              <pre className="mt-1 overflow-x-auto rounded-md bg-secondary/50 p-2.5 font-mono text-[11.5px] leading-relaxed text-secondary-foreground">
                {JSON.stringify(spec.preset, null, 2)}
              </pre>
            </div>
          )}
          {inv !== undefined && (
            <p className="text-[11.5px] text-faint">
              {t('envSourceLabel')}:{' '}
              <span className="font-mono">
                {row.key}@{inv.version}
              </span>
              {' · '}
              {fmtDateTime(inv.verify?.at ?? inv.adoptedAt)}
              {inv.verify?.digest !== undefined && (
                <>
                  {' · '}
                  <span className="font-mono">{inv.verify.digest.slice(0, 19)}…</span>
                </>
              )}
            </p>
          )}
          {c !== undefined && c.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {c.tags.map((tag) => (
                <Badge key={tag} tone="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
