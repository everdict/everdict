'use client'

import { useMemo, useState } from 'react'
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
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AgentReference } from '@/entities/agent-session'
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
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { Tooltip } from '@/shared/ui/tooltip'

import { unadoptEnvironmentAction, verifyAdoptedEnvironmentAction } from '../api/adopt-environment'
import { deleteCapabilityVersionAction } from '../api/manage-capabilities'
import { pullReasonLabel } from '../lib/pull-reason'
import { EnvironmentEditor } from './environment-editor'
import { ReachDialog } from './reach-controls'

// One row = one environment IDENTITY (source/id) — what this workspace authored and what it imported from the store are merged into
// one list and one vocabulary (the mental model is "the environments our workspace can use").
type EnvironmentRow = {
  key: string
  capability?: Capability
  inventory?: AdoptedEnvironment
}

type Scope = 'all' | 'authored' | 'imported'

// The environment-specific surface of Settings › Environments — managing registration, sharing, verification and consumption readiness in the
// environment's own language, without the store chrome (adoption stats, kind filters, publishing vocabulary). Discovery and import are the store's (the link, top right).
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
  onMention,
  onAskAgent,
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
  // The conversation entry point — the right conversation panel is the widget layer, so a feature cannot use it directly (FSD forbids importing
  // upward). A page-level client component owns the hook and passes it down through this callback (following SettingsFilesExplorer/SettingsKnowledgeMap).
  onMention?: (reference: AgentReference) => void
  onAskAgent?: (prompt: string, reference?: AgentReference) => void
}) {
  const t = useTranslations('capabilityStore')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<Capability | 'new' | null>(null)
  const [reaching, setReaching] = useState<Capability | null>(null)
  const [confirming, setConfirming] = useState<Capability | null>(null)
  const [pending, setPending] = useState(false)

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
    void (async () => {
      setPending(true)
      try {
        const r = await verifyAdoptedEnvironmentAction(e.source, e.id)
        if (!r.ok) toast.error(r.error ?? t('reverifyError'))
        else if (r.environment.verify?.pullable === false)
          toast.warning(t('importedNotPullable', { name: e.name ?? e.id }))
        else toast.success(t('reverified'))
      } finally {
        setPending(false)
      }
    })()
  const removeFromInventory = (e: AdoptedEnvironment) =>
    void (async () => {
      setPending(true)
      try {
        const r = await unadoptEnvironmentAction(e.source, e.id)
        if (r.ok) toast.success(t('unimported', { name: e.name ?? e.id }))
        else toast.error(r.error ?? t('unimportError'))
      } finally {
        setPending(false)
      }
    })()
  const del = (c: Capability) =>
    void (async () => {
      setPending(true)
      try {
        const r = await deleteCapabilityVersionAction(c.id, c.version)
        if (r.ok) toast.success(t('deleted', { name: c.name }))
        else toast.error(r.error ?? t('deleteError'))
        setConfirming(null)
      } finally {
        setPending(false)
      }
    })()

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
        {canWrite && onAskAgent !== undefined && (
          // The path from making an image straight through to registering it — the agent walks through the push command and registers it (save_capability) too.
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAskAgent(t('envRegisterInChatPrompt'))}
          >
            <Sparkles />
            {t('envRegisterInChat')}
          </Button>
        )}
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
              {...(onMention !== undefined ? { onMention } : {})}
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
  onMention,
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
  onMention?: (reference: AgentReference) => void
}) {
  const t = useTranslations('capabilityStore')
  const c = row.capability
  const spec = c?.spec.type === 'environment' ? c.spec : undefined
  const inv = row.inventory
  const image = spec?.image ?? inv?.image
  // The provenance classification is computed by the control plane against the VIEWER and sent down (the web has no classifyImageRef mirror).
  const imageClass = c?.imageClass ?? inv?.imageClass
  const benchmark = spec?.contents?.benchmark ?? inv?.benchmark
  const version = c?.version ?? inv?.version
  const author = c !== undefined ? authors[c.createdBy] : undefined
  // Only a pull-credential failure (auth) gets an inline resolution path — because its fix lives outside this screen (registering a registry in integration settings).
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
            {/* Image provenance — only the managed store (the one we issue grants for) is marked. `external` is the DEFAULT, so badging it
                turns the whole list into a field of badges and buries the one distinction that matters, "ours". */}
            {imageClass === 'managed' && (
              <Badge tone="success" className="shrink-0">
                {t('imgClass_managed')}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
            {image ?? row.key}
            {version !== undefined ? ` · ${version}` : ''}
          </div>
        </div>

        {/* The right-hand actions — stopped from bubbling into the row click (which expands it). */}
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
          {c !== undefined && onMention !== undefined && (
            // This environment as conversation context — wiring it into a harness or reworking its instructions is faster in conversation.
            <Tooltip content={t('envMentionTip')} side="top" align="end">
              <button
                type="button"
                aria-label={t('envMention')}
                onClick={() =>
                  onMention({
                    type: 'environment',
                    id: c.id,
                    version: c.version,
                    label: c.name,
                  })
                }
                className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Sparkles className="size-4" />
              </button>
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
