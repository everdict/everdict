'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  isBuiltInCapability,
  type Capability,
  type CapabilitySpec,
  type CapabilityType,
  type CapabilityVisibility,
  type EffectContract,
  type ProbeCapabilityMcpResult,
  type ValidateCapabilityResult,
} from '@/entities/capability'
import type { AdoptedEnvironment } from '@/entities/environment-adoption'
import { fmtSubject } from '@/shared/lib/format'
import { usePersistentFilters } from '@/shared/lib/use-persistent-filters'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { Link } from '@/shared/ui/link'
import { ResetFiltersButton } from '@/shared/ui/reset-filters-button'
import { StatCard } from '@/shared/ui/stat-card'
import { InfoTip } from '@/shared/ui/tooltip'

import { deleteCapabilityVersionAction, saveCapabilityAction } from '../api/manage-capabilities'
import {
  listImageTagsAction,
  probeCapabilityMcpAction,
  validateCapabilityAction,
} from '../api/wizard-tools'
import {
  capKey,
  storeItemHref,
  TYPE_ICON,
  VIS_ICON,
  type RequiredSecret,
  type StoreVariant,
} from '../lib/capability-display'
import { CodeTryPanel } from './code-try-panel'
import { ReachDialog, VisibilityPicker, WorkspacePicker } from './reach-controls'

type Author = { name: string; avatarUrl?: string }

// Store — the catalog of managed/publicly published capabilities. The same row layout as the harness and dataset lists (stats +
// filters + rows), and a row is a **link to the detail PAGE** (neither an in-place expansion nor a modal — a detail needs an address
// to sit beside an infra panel and to be shared). variant='catalog' shows public publications only (marking imported/adopted on the
// row), variant='mine' shows what my workspace published (edit/visibility/delete management plus publishing). A managed (first-party)
// entry is not "built in" but STORE-MANAGED → distinguished by a badge, and adding it to the workspace happens on the detail.
export function CapabilityStore({
  items,
  variant,
  authors,
  canWrite,
  adoptedKeys,
  importedSkillKeys,
  adoptedEnvironments,
  myWorkspaces,
  imageRegistries,
  currentWorkspace,
  currentSubject,
  isAdmin,
  allowMemberPublicPublish,
}: {
  items: Capability[]
  variant: StoreVariant
  authors: Record<string, Author>
  canWrite: boolean
  adoptedKeys: string[]
  // The source keys (source/id) of skill examples already imported — a skill becomes a workspace COPY rather than a reference, so it is judged differently.
  importedSkillKeys: string[]
  adoptedEnvironments: AdoptedEnvironment[]
  myWorkspaces: { id: string; name: string }[]
  imageRegistries: { name: string; host: string }[]
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  allowMemberPublicPublish: boolean
}) {
  const t = useTranslations('capabilityStore')
  // Client-side pagination — how many rows to render at once from a large catalog (raised by "show more"). Reset when a filter changes.
  const PAGE = 24
  const [visibleCount, setVisibleCount] = useState(PAGE)
  const [editing, setEditing] = useState<Capability | 'new' | null>(null)
  const [reaching, setReaching] = useState<Capability | null>(null)
  const [confirming, setConfirming] = useState<Capability | null>(null)
  const [pending, setPending] = useState(false)

  // Filters — the same persisted filters as the harness/dataset lists (search, kind, state, sort). Remembered per workspace and variant.
  // The state filter is gone from the catalog (what is already there is simply not shown), so the storage key is bumped to v2 so an old value cannot come back.
  const FILTER_DEFAULTS = { query: '', type: 'all', status: 'all', sort: 'recent' }
  const { values, set, reset, dirty } = usePersistentFilters(
    `store:${variant}:v2:${currentWorkspace}`,
    FILTER_DEFAULTS
  )
  const { query, type, status, sort } = values

  const adopted = useMemo(() => new Set(adoptedKeys), [adoptedKeys])
  // Imported environment images — source/id → inventory entry (its usability verification state). For environment's "imported / import".
  const adoptedEnvMap = useMemo(
    () => new Map(adoptedEnvironments.map((e) => [`${e.source}/${e.id}`, e])),
    [adoptedEnvironments]
  )
  // Skill examples already imported — the library copy remembers its source (a copy, not a subscription, so it is not in the adoption list).
  const importedSkills = useMemo(() => new Set(importedSkillKeys), [importedSkillKeys])
  // Is it already in the workspace — an environment is the inventory, a skill is the library copy, everything else is an agent adoption.
  const inWorkspace = useCallback(
    (c: Capability): boolean =>
      c.spec.type === 'environment'
        ? adoptedEnvMap.has(capKey(c))
        : c.spec.type === 'skill'
          ? importedSkills.has(capKey(c))
          : adopted.has(capKey(c)),
    [adopted, adoptedEnvMap, importedSkills]
  )

  // May they publish public? An admin always; a member when the instance policy allows it. (The server enforces it finally — this is UX gating.)
  const canPublishPublic = isAdmin || allowMemberPublicPublish
  // The management menu (edit/visibility/delete) appears only in the "mine" view, only when not managed, and only for the creator or an admin. The catalog is browse-only.
  const canManage = (c: Capability) =>
    variant === 'mine' && !isBuiltInCapability(c) && (c.createdBy === currentSubject || isAdmin)
  const authorOf = (createdBy: string): Author => {
    const a = authors[createdBy]
    return {
      name: a?.name ?? fmtSubject(createdBy),
      ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
    }
  }

  // The catalog is a DISCOVERY list — what is already in the workspace is hidden here (managed under Settings › Agent · Environments).
  // "Mine" must show everything I published, so it hides nothing and distinguishes with the state filter instead.
  const browsable = useMemo(
    () => (variant === 'catalog' ? items.filter((c) => !inWorkspace(c)) : items),
    [items, variant, inWorkspace]
  )

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = browsable.filter((c) => {
      if (type !== 'all' && c.spec.type !== type) return false
      if (variant === 'mine' && status === 'adopted' && !inWorkspace(c)) return false
      if (variant === 'mine' && status === 'not' && inWorkspace(c)) return false
      return (
        q.length === 0 ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.tags.some((tag) => tag.toLowerCase().includes(q))
      )
    })
    // Managed (the catalog's face) first, then the chosen sort. recent = newest publication, name = by name, type = by kind.
    return [...filtered].sort((a, b) => {
      if (isBuiltInCapability(a) !== isBuiltInCapability(b)) return isBuiltInCapability(a) ? -1 : 1
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'type')
        return a.spec.type.localeCompare(b.spec.type) || a.name.localeCompare(b.name)
      return b.createdAt.localeCompare(a.createdAt) // recent
    })
  }, [browsable, query, type, status, sort, variant, inWorkspace])

    // Reset pagination to the first page whenever a filter changes.
  useEffect(() => setVisibleCount(PAGE), [query, type, status, sort])
  const visible = list.slice(0, visibleCount)

  const adoptedCount = useMemo(() => items.filter(inWorkspace).length, [items, inWorkspace])
  const managedCount = useMemo(() => items.filter(isBuiltInCapability).length, [items])

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

  const typeOptions = [
    { value: 'all', label: t('typeLabel') },
    { value: 'mcp', label: t('type_mcp') },
    { value: 'code', label: t('type_code') },
    { value: 'skill', label: t('type_skill') },
    { value: 'environment', label: t('type_environment') },
    { value: 'delegation', label: t('type_delegation') },
  ]
  const statusOptions = [
    { value: 'all', label: t('statusLabel') },
    { value: 'adopted', label: t('statusAdopted') },
    { value: 'not', label: t('statusNotAdopted') },
  ]
  const sortOptions = [
    { value: 'recent', label: t('sortRecent') },
    { value: 'name', label: t('sortName') },
    { value: 'type', label: t('sortType') },
  ]

  const showActionRow = variant === 'mine' || (variant === 'catalog' && canWrite)

  return (
    <div className="space-y-5">
      {showActionRow && (
        <div className="flex items-center justify-between gap-2">
          <div>
            {variant === 'mine' && (
              <Link
                href={`/${currentWorkspace}/store`}
                className="inline-flex items-center gap-1 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowRight className="size-3.5 rotate-180" />
                {t('backToStore')}
              </Link>
            )}
          </div>
          <div className="flex items-center gap-3">
            {variant === 'catalog' && canWrite && (
              <Link
                href={`/${currentWorkspace}/store/mine`}
                className="inline-flex items-center gap-1 text-[13px] font-[510] text-link transition-colors hover:text-foreground"
              >
                {t('myPublished')}
                <ArrowRight className="size-3.5" />
              </Link>
            )}
            {variant === 'mine' && canWrite && (
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus />
                {t('publish')}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className={cn('grid gap-3', variant === 'catalog' ? 'grid-cols-3' : 'grid-cols-2')}>
        <StatCard label={t('statTotal')} value={items.length} />
        <StatCard
          label={
            variant === 'catalog' ? (
              // Where the entries hidden from the list went — an info icon rather than an inline paragraph.
              <span className="inline-flex items-center gap-1">
                {t('statInWorkspace')}
                <InfoTip content={t('statInWorkspaceTip')} align="start" />
              </span>
            ) : (
              t('statInWorkspace')
            )
          }
          value={adoptedCount}
          tone={adoptedCount > 0 ? 'primary' : 'default'}
        />
        {variant === 'catalog' && <StatCard label={t('statManaged')} value={managedCount} />}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => set('query', e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchPlaceholder')}
          />
        </div>
        <Combobox
          options={typeOptions}
          value={type}
          onChange={(v) => set('type', v)}
          className="w-[140px]"
          aria-label={t('typeLabel')}
        />
        {/* The state filter is exclusive to the "mine" view — the catalog only ever holds "not yet in the workspace", so there is no state to pick. */}
        {variant === 'mine' && (
          <Combobox
            options={statusOptions}
            value={status}
            onChange={(v) => set('status', v)}
            className="w-[150px]"
            aria-label={t('statusLabel')}
          />
        )}
        <Combobox
          options={sortOptions}
          value={sort}
          onChange={(v) => set('sort', v)}
          className="w-[150px]"
          align="end"
          aria-label={t('sortBy')}
        />
        {dirty && <ResetFiltersButton onClick={reset} />}
      </div>

      {list.length === 0 ? (
        // Having imported the whole catalog and "there is nothing yet" are different situations — say why things are hidden.
        variant === 'catalog' && browsable.length === 0 && items.length > 0 ? (
          <EmptyState icon={<CircleCheck />} title={t('allAddedTitle')} hint={t('allAddedHint')} />
        ) : (
          <EmptyState
            icon={<Boxes />}
            title={t(variant === 'mine' ? 'mineEmptyTitle' : 'emptyTitle')}
            hint={t(variant === 'mine' ? 'mineEmptyHint' : 'emptyHint')}
            {...(variant === 'mine' && canWrite
              ? { action: <Button onClick={() => setEditing('new')}>{t('publish')}</Button> }
              : {})}
          />
        )
      ) : (
        <div className="space-y-2">
          {visible.map((c) => {
            const author = authorOf(c.createdBy)
            const TypeIcon = TYPE_ICON[c.spec.type]
            const VisIcon = VIS_ICON[c.visibility]
            const managed = isBuiltInCapability(c)
            const here = inWorkspace(c)
            return (
              <Link
                key={capKey(c)}
                href={storeItemHref(currentWorkspace, c, variant === 'mine' ? 'mine' : undefined)}
                className="group block rounded-lg border bg-card p-3.5 shadow-raise outline-none transition-colors hover:border-border-strong hover:bg-elevated focus-visible:border-border-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                      <TypeIcon className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-[13px] font-[560] text-foreground">
                          {c.name}
                        </span>
                        <Badge tone="outline" className="shrink-0">
                          {t(`type_${c.spec.type}`)}
                        </Badge>
                        {managed && (
                          <Badge tone="info" title={t('managedHint')} className="shrink-0 gap-1">
                            <Sparkles className="size-3" />
                            {t('managed')}
                          </Badge>
                        )}
                        {variant === 'mine' && (
                          <Badge
                            tone={c.visibility === 'private' ? 'outline' : 'info'}
                            className="shrink-0 gap-1"
                          >
                            <VisIcon className="size-3" />
                            {t(`vis_${c.visibility}`)}
                          </Badge>
                        )}
                        {here && (
                          <Badge tone="success" className="shrink-0">
                            {t('inWorkspaceBadge')}
                          </Badge>
                        )}
                        <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground ring-1 ring-inset ring-border">
                          {c.version}
                        </code>
                      </div>
                      <p className="line-clamp-1 text-[12px] text-muted-foreground">
                        {c.description}
                      </p>
                      <RowMeta capability={c} />
                    </div>
                  </div>
                  {/* Right — the row is READ-ONLY. Adding to or removing from the workspace happens only on the detail, so no button eats row space
                      (Linear-style: a quiet row, with a drill-in signal on hover). Only the management menu stays in place, and since the whole row is
                      a link to the detail, a click on the menu suppresses the navigation. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {canManage(c) && (
                      <span
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                      >
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
                          <DropdownItem icon={<Pencil />} onSelect={() => setEditing(c)}>
                            {t('edit')}
                          </DropdownItem>
                          <DropdownItem icon={<Share2 />} onSelect={() => setReaching(c)}>
                            {t('changeReach')}
                          </DropdownItem>
                          <DropdownSeparator />
                          <DropdownItem
                            icon={<Trash2 />}
                            tone="danger"
                            onSelect={() => setConfirming(c)}
                          >
                            {t('delete')}
                          </DropdownItem>
                        </DropdownMenu>
                      </span>
                    )}
                    <Avatar
                      name={author.name}
                      url={author.avatarUrl}
                      size="sm"
                      className="rounded-full"
                    />
                    <ChevronRight
                      className="size-4 text-faint opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {visibleCount < list.length && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => setVisibleCount((n) => n + PAGE)}>
            {t('showMore')}
          </Button>
        </div>
      )}

      {editing !== null && (
        <CapabilityEditorDialog
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

// Row meta — a one-line summary per kind (mcp = the tools it provides, code = language + read-only, environment = the image ref) plus a few tags. Nothing to say: not rendered.
function RowMeta({ capability }: { capability: Capability }) {
  const t = useTranslations('capabilityStore')
  const s = capability.spec
  const hasTypeMeta =
    s.type === 'mcp' ? s.provides.length > 0 : s.type === 'code' || s.type === 'environment'
  if (!hasTypeMeta && capability.tags.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
      {s.type === 'mcp' &&
        s.provides.slice(0, 3).map((p) => (
          <code
            key={p}
            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground"
          >
            {p}
          </code>
        ))}
      {s.type === 'code' && (
        <>
          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground">
            {s.language}
          </span>
          <span>{t(s.isReadOnly ? 'codeReadOnly' : 'codeWrites')}</span>
        </>
      )}
      {s.type === 'environment' && (
        <code className="max-w-[16rem] truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground">
          {s.image}
        </code>
      )}
      {capability.tags.slice(0, 3).map((tag) => (
        <span
          key={tag}
          className="rounded bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
        >
          #{tag}
        </span>
      ))}
    </div>
  )
}

// The publish/edit dialog. A NEW capability picks id + type + visibility; an edit is content only (reach is ⋯ → change reach).
function CapabilityEditorDialog({
  capability,
  myWorkspaces,
  imageRegistries,
  ownerId,
  canPublishPublic,
  onClose,
}: {
  capability: Capability | null
  myWorkspaces: { id: string; name: string }[]
  imageRegistries: { name: string; host: string }[]
  ownerId: string
  canPublishPublic: boolean
  onClose: () => void
}) {
  const t = useTranslations('capabilityStore')
  const isNew = capability === null
  const [id, setId] = useState(capability?.id ?? '')
  const [name, setName] = useState(capability?.name ?? '')
  const [description, setDescription] = useState(capability?.description ?? '')
  const [type, setType] = useState<CapabilityType>(capability?.spec.type ?? 'mcp')
  const [visibility, setVisibility] = useState<CapabilityVisibility>(
    capability?.visibility ?? 'private'
  )
  const [sharedWith, setSharedWith] = useState<string[]>(capability?.sharedWith ?? [])
  const [tags, setTags] = useState((capability?.tags ?? []).join(', '))

  // mcp
  const mcp = capability?.spec.type === 'mcp' ? capability.spec : undefined
  // Two transports: a remote HTTP url (default) or a container image (stdio). When editing, the presence of an image means image mode.
  const [mcpImageMode, setMcpImageMode] = useState(!!mcp?.image)
  const [url, setUrl] = useState(mcp?.url ?? '')
  const [image, setImage] = useState(mcp?.image ?? '')
  const [imageArgs, setImageArgs] = useState((mcp?.args ?? []).join(' '))
  const [provides, setProvides] = useState((mcp?.provides ?? []).join(', '))
  const [mcpWrite, setMcpWrite] = useState(mcp?.write ?? false)
  // The effect contract (O4) — one set shared by mcp and code. It appears in the form only once the tool can WRITE, and it is sent only then:
  // attaching a contract to a read-only tool is allowed, but generating one automatically makes it a declaration nobody made.
  const [effects, setEffects] = useState<EffectContract>(
    (capability?.spec.type === 'mcp' || capability?.spec.type === 'code'
      ? capability.spec.effects
      : undefined) ?? { sideEffect: 'workspace' }
  )
  // The mcp connection test (probe) — a test-only token (never stored) plus the result (reachability + discovered tools, which fill `provides`).
  const [probeToken, setProbeToken] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ProbeCapabilityMcpResult | null>(null)
  // The pre-save validation (dry-run) result — common to every kind (shown inline in the footer).
  const [validateResult, setValidateResult] = useState<ValidateCapabilityResult | null>(null)
  // code
  const code = capability?.spec.type === 'code' ? capability.spec : undefined
  const [language, setLanguage] = useState<'python' | 'node'>(code?.language ?? 'python')
  const [source, setSource] = useState(code?.code ?? '')
  const [params, setParams] = useState(code ? JSON.stringify(code.parametersSchema, null, 2) : '{}')
  const [isReadOnly, setIsReadOnly] = useState(code?.isReadOnly ?? true)
  // Worked examples (row editing: name / input JSON / note) — used three ways: the store detail, the try runner, and the agent tool description.
  const [codeExamples, setCodeExamples] = useState<{ name: string; input: string; note: string }[]>(
    (code?.examples ?? []).map((e) => ({
      name: e.name ?? '',
      input: JSON.stringify(e.input),
      note: e.note ?? '',
    }))
  )
  // Shared by skill and environment — both carry an instructions body (a skill = the procedure, an environment = the composition described).
  const skill = capability?.spec.type === 'skill' ? capability.spec : undefined
  const env = capability?.spec.type === 'environment' ? capability.spec : undefined
  const [instructions, setInstructions] = useState(skill?.instructions ?? env?.instructions ?? '')
  // environment
  const [envImage, setEnvImage] = useState(env?.image ?? '')
  const [envBenchmark, setEnvBenchmark] = useState(env?.contents?.benchmark ?? '')
  const [envPackages, setEnvPackages] = useState((env?.contents?.packages ?? []).join(', '))
  const [envOs, setEnvOs] = useState(env?.contents?.os ?? '')
  const [envArch, setEnvArch] = useState(env?.contents?.arch ?? '')
  const [envPreset, setEnvPreset] = useState(env?.preset ? JSON.stringify(env.preset, null, 2) : '')
  // The environment image tag picker — reads the workspace registry's repository tags and assembles an image ref (host/repo:tag).
  const [tagRegistry, setTagRegistry] = useState(imageRegistries[0]?.name ?? '')
  const [tagRepo, setTagRepo] = useState('')
  const [tagLoading, setTagLoading] = useState(false)
  const [imageTags, setImageTags] = useState<string[] | null>(null)

  const initialSecrets: RequiredSecret[] = mcp?.requiredSecrets ?? code?.requiredSecrets ?? []
  const [secrets, setSecrets] = useState<RequiredSecret[]>(initialSecrets)

  const [pending, setPending] = useState(false)

  const splitCsv = (s: string): string[] =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)

  const buildSpec = (): CapabilitySpec | { error: string } => {
    const cleanSecrets = secrets.filter((s) => s.name.trim().length > 0)
    if (type === 'mcp') {
      // Two transports — a remote HTTP url OR a container image the agent runs over stdio (`docker run -i`).
      if (mcpImageMode) {
        if (!image.trim()) return { error: t('imageRequired') }
        return {
          type: 'mcp',
          image: image.trim(),
          // args are whitespace-split (e.g. "-t stdio" → ["-t","stdio"]); requiredSecrets become container env vars.
          args: imageArgs.trim() ? imageArgs.trim().split(/\s+/) : [],
          provides: splitCsv(provides),
          requiredSecrets: cleanSecrets,
          write: mcpWrite,
          ...(mcpWrite ? { effects } : {}),
        }
      }
      if (!url.trim()) return { error: t('urlRequired') }
      return {
        type: 'mcp',
        url: url.trim(),
        args: [],
        provides: splitCsv(provides),
        requiredSecrets: cleanSecrets,
        write: mcpWrite,
        ...(mcpWrite ? { effects } : {}),
      }
    }
    if (type === 'code') {
      let parametersSchema: Record<string, unknown> = {}
      const raw = params.trim()
      if (raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return { error: t('paramsInvalid') }
          parametersSchema = parsed as Record<string, unknown>
        } catch {
          return { error: t('paramsInvalid') }
        }
      }
      // Example rows → spec.examples. A completely empty row is skipped, and an input that is not a JSON object blocks the save.
      const examples: NonNullable<Extract<CapabilitySpec, { type: 'code' }>['examples']> = []
      for (const row of codeExamples) {
        if (
          row.name.trim().length === 0 &&
          row.input.trim().length === 0 &&
          row.note.trim().length === 0
        )
          continue
        try {
          const parsed: unknown = row.input.trim().length > 0 ? JSON.parse(row.input) : {}
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return { error: t('exampleInvalid') }
          examples.push({
            ...(row.name.trim() ? { name: row.name.trim() } : {}),
            input: parsed as Record<string, unknown>,
            ...(row.note.trim() ? { note: row.note.trim() } : {}),
          })
        } catch {
          return { error: t('exampleInvalid') }
        }
      }
      return {
        type: 'code',
        language,
        code: source,
        parametersSchema,
        isReadOnly,
        requiredSecrets: cleanSecrets,
        examples,
        ...(isReadOnly ? {} : { effects }),
      }
    }
    if (type === 'environment') {
      // A preset is topology sub-vocabulary JSON — edited as raw JSON (following the overrides JSON textarea), and finally validated by the control plane.
      type EnvPreset = NonNullable<Extract<CapabilitySpec, { type: 'environment' }>['preset']>
      let preset: EnvPreset | undefined
      const rawPreset = envPreset.trim()
      if (rawPreset.length > 0) {
        try {
          const parsed: unknown = JSON.parse(rawPreset)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return { error: t('presetInvalid') }
          preset = parsed as EnvPreset
        } catch {
          return { error: t('presetInvalid') }
        }
      }
      const packages = splitCsv(envPackages)
      const benchmark = envBenchmark.trim()
      const os = envOs.trim()
      const arch = envArch.trim()
      const hasContents =
        packages.length > 0 || benchmark.length > 0 || os.length > 0 || arch.length > 0
      return {
        type: 'environment',
        image: envImage.trim(),
        ...(hasContents
          ? {
              contents: {
                packages,
                ...(benchmark ? { benchmark } : {}),
                ...(os ? { os } : {}),
                ...(arch ? { arch } : {}),
              },
            }
          : {}),
        ...(preset !== undefined ? { preset } : {}),
        instructions,
      }
    }
    // The wizard does not author attached files — editing an existing skill PRESERVES the original file set (otherwise an edit deletes the files).
    return { type: 'skill', instructions, files: skill?.files ?? [] }
  }

  // The mcp connection test — test-connect with the URL (+ optional token) and discover its tools. A failure is a RESULT (reachable:false), not an error.
  const runProbe = () => {
    setProbing(true)
    setProbeResult(null)
    void probeCapabilityMcpAction(url.trim(), probeToken.trim() || undefined).then((r) => {
      setProbing(false)
      if (r.ok && r.result) setProbeResult(r.result)
      else toast.error(r.error ?? t('probeError'))
    })
  }
  // Fill `provides` from the discovered tool names (replacing manual entry).
  const fillProvides = () => {
    if (probeResult) setProvides(probeResult.tools.map((tool) => tool.name).join(', '))
  }

  // Environment image tag lookup — the tag list of a repository (+ an optional registry).
  const runListTags = () => {
    setTagLoading(true)
    setImageTags(null)
    void listImageTagsAction(tagRepo.trim(), tagRegistry || undefined).then((r) => {
      setTagLoading(false)
      if (r.ok && r.tags) setImageTags(r.tags)
      else toast.error(r.error ?? t('tagsError'))
    })
  }
  // Picking a tag assembles the image ref as host/repository:tag. (A mutable-tag warning is raised at save/validate.)
  const pickTag = (tag: string) => {
    const host = imageRegistries.find((reg) => reg.name === tagRegistry)?.host
    setEnvImage(`${host ? `${host}/` : ''}${tagRepo.trim()}:${tag}`)
  }

  // Pre-save validation (dry-run) — shows inline whether this is a new capability or a new version, the predicted version, and image warnings.
  const runValidate = () =>
    void (async () => {
      setPending(true)
      try {
        const spec = buildSpec()
        if ('error' in spec) {
          setValidateResult({ ok: false, errors: [spec.error] })
          return
        }
        const r = await validateCapabilityAction(
          (isNew ? id.trim() : capability.id) || '(unnamed)',
          name.trim(),
          description.trim(),
          spec
        )
        if (r.ok && r.result) setValidateResult(r.result)
        else toast.error(r.error ?? t('saveError'))
      } finally {
        setPending(false)
      }
    })()

  const save = () =>
    void (async () => {
      setPending(true)
      try {
        const spec = buildSpec()
        if ('error' in spec) {
          toast.error(spec.error)
          return
        }
        const r = await saveCapabilityAction(isNew ? id.trim() : capability.id, {
          name,
          description,
          spec,
          ...(isNew ? { visibility, sharedWith } : {}),
          tags: splitCsv(tags),
        })
        if (r.ok) {
          toast.success(isNew ? t('published', { name }) : t('saved', { name }))
          // Image classification warnings (warn, not block) — the publish succeeds; only pull guarantees and reproducibility are flagged.
          for (const w of r.result?.imageWarnings ?? [])
            toast.warning(
              t(`imageWarning_${w.class === 'mutable-tag' ? 'mutableTag' : 'noPull'}`, {
                image: w.image,
              })
            )
          onClose()
        } else {
          toast.error(r.error ?? t('saveError'))
        }
      } finally {
        setPending(false)
      }
    })()

  const canSave =
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    (isNew ? id.trim().length > 0 : true) &&
    (type === 'mcp'
      ? url.trim().length > 0
      : type === 'code'
        ? source.trim().length > 0
        : type === 'environment'
          ? envImage.trim().length > 0 && instructions.trim().length > 0
          : instructions.trim().length > 0)

  return (
    <Dialog open onClose={onClose} align="top" className="max-w-2xl">
      <div className="max-h-[85vh] space-y-5 overflow-y-auto p-6">
        <h3 className="text-sm font-medium">{isNew ? t('publishTitle') : t('editTitle')}</h3>

        {isNew && (
          <div className="space-y-1">
            <Label htmlFor="cap-id">{t('id')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('idHint')}</p>
            <Input
              id="cap-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-scorer"
              className="font-mono text-[13px]"
            />
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="cap-name">{t('name')}</Label>
          <Input
            id="cap-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-[13px]"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cap-desc">{t('descriptionLabel')}</Label>
          <p className="text-[12px] text-muted-foreground">{t('descriptionHint')}</p>
          <Input
            id="cap-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Type — selectable only on a NEW capability (it is content identity) */}
        <div className="space-y-1">
          <Label>{t('type')}</Label>
          <div className="flex gap-1">
            {(['mcp', 'code', 'skill', 'environment'] as const).map((k) => (
              <button
                key={k}
                type="button"
                disabled={!isNew}
                onClick={() => setType(k)}
                className={cn(
                  'flex-1 rounded-md px-3 py-2 text-[13px] font-medium ring-1 ring-inset transition-colors disabled:opacity-60',
                  type === k
                    ? 'bg-primary/10 text-primary ring-primary/30'
                    : 'text-muted-foreground ring-border hover:bg-accent'
                )}
              >
                {t(`type_${k}`)}
              </button>
            ))}
          </div>
        </div>

        {type === 'mcp' && (
          <>
            {/* The transport toggle — a remote HTTP url vs a container image (stdio, `docker run -i`) */}
            <div className="space-y-1">
              <Label>{t('mcpTransport')}</Label>
              <div className="flex gap-1">
                {([false, true] as const).map((imageMode) => (
                  <button
                    key={String(imageMode)}
                    type="button"
                    onClick={() => setMcpImageMode(imageMode)}
                    className={cn(
                      'flex-1 rounded-md px-3 py-2 text-[13px] font-medium ring-1 ring-inset transition-colors',
                      mcpImageMode === imageMode
                        ? 'bg-primary/10 text-primary ring-primary/30'
                        : 'text-muted-foreground ring-border hover:bg-accent'
                    )}
                  >
                    {t(imageMode ? 'mcpTransportImage' : 'mcpTransportUrl')}
                  </button>
                ))}
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                {t(mcpImageMode ? 'mcpTransportImageHint' : 'mcpTransportUrlHint')}
              </p>
            </div>

            {mcpImageMode ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="cap-image">{t('mcpImage')}</Label>
                  <Input
                    id="cap-image"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    placeholder="grafana/mcp-grafana"
                    className="font-mono text-[13px]"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cap-args">{t('mcpArgs')}</Label>
                  <p className="text-[12px] text-muted-foreground">{t('mcpArgsHint')}</p>
                  <Input
                    id="cap-args"
                    value={imageArgs}
                    onChange={(e) => setImageArgs(e.target.value)}
                    placeholder="-t stdio"
                    className="font-mono text-[13px]"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="cap-url">{t('mcpUrl')}</Label>
                  <Input
                    id="cap-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    className="font-mono text-[13px]"
                  />
                </div>
                {/* Connection test — test-connect with the URL (+ optional token) and discover its tools → fills `provides` */}
                <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[10rem] flex-1 space-y-1">
                      <Label htmlFor="cap-probe-token">{t('probeToken')}</Label>
                      <Input
                        id="cap-probe-token"
                        type="password"
                        value={probeToken}
                        onChange={(e) => setProbeToken(e.target.value)}
                        placeholder={t('probeTokenPlaceholder')}
                        className="font-mono text-[12px]"
                      />
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={probing || url.trim().length === 0}
                      onClick={runProbe}
                    >
                      {probing ? <Loader2 className="animate-spin" /> : <Zap />}
                      {t('testConnection')}
                    </Button>
                  </div>
                  <p className="text-[11.5px] text-muted-foreground">{t('probeTokenHint')}</p>
                  {probeResult && (
                    <div className="space-y-2 border-t border-border pt-2">
                      <div
                        className={cn(
                          'flex items-center gap-1.5 text-[12.5px] font-medium',
                          probeResult.reachable ? 'text-success' : 'text-destructive'
                        )}
                      >
                        {probeResult.reachable ? (
                          <CircleCheck className="size-4" />
                        ) : (
                          <CircleAlert className="size-4" />
                        )}
                        <span>{probeResult.detail}</span>
                      </div>
                      {probeResult.tools.length > 0 && (
                        <>
                          <div className="flex flex-wrap gap-1">
                            {probeResult.tools.map((tool) => (
                              <Badge key={tool.name} tone="neutral" title={tool.description}>
                                {tool.name}
                              </Badge>
                            ))}
                          </div>
                          <Button variant="ghost" size="sm" onClick={fillProvides}>
                            <Check />
                            {t('fillProvides')}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="cap-provides">{t('provides')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('providesHint')}</p>
              <Input
                id="cap-provides"
                value={provides}
                onChange={(e) => setProvides(e.target.value)}
                className="font-mono text-[13px]"
              />
            </div>
            <RequiredSecretsEditor secrets={secrets} onChange={setSecrets} t={t} />
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="accent-primary"
                checked={mcpWrite}
                onChange={(e) => setMcpWrite(e.target.checked)}
              />
              <span>{t('mcpWrite')}</span>
            </label>
            {mcpWrite && <EffectContractEditor value={effects} onChange={setEffects} t={t} />}
          </>
        )}

        {type === 'code' && (
          <>
            <div className="space-y-1">
              <Label>{t('language')}</Label>
              <div className="flex gap-1">
                {(['python', 'node'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setLanguage(k)}
                    className={cn(
                      'flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium ring-1 ring-inset transition-colors',
                      language === k
                        ? 'bg-primary/10 text-primary ring-primary/30'
                        : 'text-muted-foreground ring-border hover:bg-accent'
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cap-code">{t('code')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('codeHint')}</p>
              <CodeEditor
                value={source}
                onChange={setSource}
                language={language}
                minHeight="220px"
                maxHeight="420px"
                aria-label={t('code')}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cap-params">{t('params')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('paramsHint')}</p>
              <Textarea
                id="cap-params"
                value={params}
                onChange={(e) => setParams(e.target.value)}
                rows={4}
                className="font-mono text-[12px]"
              />
            </div>
            <RequiredSecretsEditor secrets={secrets} onChange={setSecrets} t={t} />
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="accent-primary"
                checked={isReadOnly}
                onChange={(e) => setIsReadOnly(e.target.checked)}
              />
              <span>{t('isReadOnly')}</span>
            </label>
            {!isReadOnly && <EffectContractEditor value={effects} onChange={setEffects} t={t} />}
            {/* Worked examples — show what this tool does in the shape of its INPUT (used three ways: the detail view, try, and the tool description) */}
            <div className="space-y-1.5">
              <Label>{t('examplesLabel')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('examplesHint')}</p>
              {codeExamples.map((row, i) => (
                <div key={i} className="space-y-1.5 rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-2">
                    <Input
                      value={row.name}
                      onChange={(e) =>
                        setCodeExamples((p) =>
                          p.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x))
                        )
                      }
                      placeholder={t('exampleName')}
                      className="text-[12px]"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setCodeExamples((p) => p.filter((_, idx) => idx !== i))}
                      aria-label={t('remove')}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <Textarea
                    value={row.input}
                    onChange={(e) =>
                      setCodeExamples((p) =>
                        p.map((x, idx) => (idx === i ? { ...x, input: e.target.value } : x))
                      )
                    }
                    rows={2}
                    placeholder='{"query": "…"}'
                    className="font-mono text-[12px]"
                  />
                  <Input
                    value={row.note}
                    onChange={(e) =>
                      setCodeExamples((p) =>
                        p.map((x, idx) => (idx === i ? { ...x, note: e.target.value } : x))
                      )
                    }
                    placeholder={t('exampleNote')}
                    className="text-[12px]"
                  />
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCodeExamples((p) => [...p, { name: '', input: '{}', note: '' }])}
                disabled={codeExamples.length >= 8}
              >
                <Plus />
                {t('addExample')}
              </Button>
            </div>
            {/* Pre-publish validation — check (syntax) and run (execute an example). Nothing is published on a reading of the code alone. */}
            <CodeTryPanel
              showCheck
              buildTarget={() => {
                const spec = buildSpec()
                if ('error' in spec) return spec
                return { name: name.trim().length > 0 ? name.trim() : 'draft-tool', spec }
              }}
              initialInput={codeExamples[0]?.input ?? '{}'}
            />
          </>
        )}

        {type === 'skill' && (
          <div className="space-y-1">
            <Label htmlFor="cap-instructions">{t('instructions')}</Label>
            <Textarea
              id="cap-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={10}
              className="font-mono text-[13px]"
            />
          </div>
        )}

        {type === 'environment' && (
          <>
            <div className="space-y-1">
              <Label htmlFor="cap-env-image">{t('envImage')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('envImageHint')}</p>
              <Input
                id="cap-env-image"
                value={envImage}
                onChange={(e) => setEnvImage(e.target.value)}
                placeholder="ghcr.io/acme/officeqa-env@sha256:…"
                className="font-mono text-[13px]"
              />
            </div>
            {/* The image tag picker — reads the workspace registry's repository tags and assembles the image ref (replacing manual typing) */}
            {imageRegistries.length > 0 && (
              <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  {imageRegistries.length > 1 && (
                    <div className="space-y-1">
                      <Label htmlFor="cap-tag-registry">{t('tagRegistry')}</Label>
                      <Combobox
                        id="cap-tag-registry"
                        options={imageRegistries.map((reg) => ({
                          value: reg.name,
                          label: reg.name,
                        }))}
                        value={tagRegistry}
                        onChange={setTagRegistry}
                        className="w-[160px]"
                        aria-label={t('tagRegistry')}
                      />
                    </div>
                  )}
                  <div className="min-w-[10rem] flex-1 space-y-1">
                    <Label htmlFor="cap-tag-repo">{t('tagRepo')}</Label>
                    <Input
                      id="cap-tag-repo"
                      value={tagRepo}
                      onChange={(e) => setTagRepo(e.target.value)}
                      placeholder="acme/officeqa-env"
                      className="font-mono text-[12px]"
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={tagLoading || tagRepo.trim().length === 0}
                    onClick={runListTags}
                  >
                    {tagLoading ? <Loader2 className="animate-spin" /> : <Boxes />}
                    {t('listTags')}
                  </Button>
                </div>
                {imageTags !== null &&
                  (imageTags.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">{t('tagsNone')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {imageTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => pickTag(tag)}
                          className="rounded-md px-2 py-0.5 font-mono text-[11.5px] text-muted-foreground ring-1 ring-inset ring-border transition-colors hover:bg-primary/10 hover:text-primary hover:ring-primary/30"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="cap-env-benchmark">{t('envBenchmark')}</Label>
                <Input
                  id="cap-env-benchmark"
                  value={envBenchmark}
                  onChange={(e) => setEnvBenchmark(e.target.value)}
                  placeholder="officeqa"
                  className="text-[13px]"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cap-env-packages">{t('envPackages')}</Label>
                <Input
                  id="cap-env-packages"
                  value={envPackages}
                  onChange={(e) => setEnvPackages(e.target.value)}
                  placeholder="libreoffice, python3.12"
                  className="text-[13px]"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cap-env-os">{t('envOs')}</Label>
                <Input
                  id="cap-env-os"
                  value={envOs}
                  onChange={(e) => setEnvOs(e.target.value)}
                  placeholder="linux"
                  className="text-[13px]"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cap-env-arch">{t('envArch')}</Label>
                <Input
                  id="cap-env-arch"
                  value={envArch}
                  onChange={(e) => setEnvArch(e.target.value)}
                  placeholder="amd64"
                  className="text-[13px]"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cap-env-preset">{t('envPreset')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('envPresetHint')}</p>
              <Textarea
                id="cap-env-preset"
                value={envPreset}
                onChange={(e) => setEnvPreset(e.target.value)}
                rows={6}
                placeholder={'{ "service": { "port": 8000 }, "dependencies": [] }'}
                className="font-mono text-[12px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cap-env-instructions">{t('envInstructions')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('envInstructionsHint')}</p>
              <Textarea
                id="cap-env-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={8}
                className="font-mono text-[13px]"
              />
            </div>
          </>
        )}

        <div className="space-y-1">
          <Label htmlFor="cap-tags">{t('tags')}</Label>
          <Input
            id="cap-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="text-[13px]"
          />
        </div>

        {isNew && (
          <div className="space-y-1">
            <Label>{t('visibility')}</Label>
            <VisibilityPicker
              value={visibility}
              onChange={setVisibility}
              t={t}
              disablePublic={!canPublishPublic}
            />
            {visibility === 'public' && !canPublishPublic && (
              <p className="text-[12px] text-muted-foreground">{t('publicAdminOnly')}</p>
            )}
            {visibility === 'subset' && (
              <div className="space-y-1 pt-1">
                <Label>{t('sharedWith')}</Label>
                <p className="text-[12px] text-muted-foreground">{t('sharedWithHint')}</p>
                <WorkspacePicker
                  workspaces={myWorkspaces}
                  ownerId={ownerId}
                  value={sharedWith}
                  onChange={setSharedWith}
                  emptyHint={t('sharedWithEmpty')}
                />
              </div>
            )}
          </div>
        )}

        {/* The pre-save validation (dry-run) result — new capability or new version, the predicted version, and spec errors / image warnings */}
        {validateResult &&
          (validateResult.ok ? (
            <div className="space-y-1.5 rounded-md border border-border bg-secondary/30 p-3 text-[12.5px]">
              <div className="flex items-center gap-1.5 font-medium text-success">
                <CircleCheck className="size-4" />
                <span>
                  {validateResult.willCreate
                    ? t(
                        validateResult.existingVersions.length === 0
                          ? 'validateNew'
                          : 'validateNewVersion',
                        {
                          version: validateResult.version,
                        }
                      )
                    : t('validateNoop', { version: validateResult.version })}
                </span>
              </div>
              {(validateResult.imageWarnings ?? []).map((w) => (
                <div key={w.image} className="flex items-center gap-1.5 text-warning">
                  <CircleAlert className="size-3.5" />
                  <span className="font-mono">{w.image}</span>
                  <span>— {w.class}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px]">
              <div className="flex items-center gap-1.5 font-medium text-destructive">
                <CircleAlert className="size-4" />
                <span>{t('validateFailed')}</span>
              </div>
              {validateResult.errors.map((e) => (
                <p key={e} className="pl-5 text-muted-foreground">
                  {e}
                </p>
              ))}
            </div>
          ))}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="ghost" size="sm" onClick={runValidate} disabled={pending || !canSave}>
            {t('validate')}
          </Button>
          <Button size="sm" onClick={save} disabled={pending || !canSave}>
            {pending ? t('saving') : isNew ? t('publish') : t('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// Required-secret editing — name + description rows (add/remove). The adopter fills them with their own secrets (names, never values).
// The effect contract (O4) editor — visible only on a tool that can write. The control plane's domain guard REQUIRES a declaration on a
// write tool (saving without one is a 400), so without this form the web could not create a mutating tool at all. A rollback is a TAGGED
// shape: prose is read by people only, and the permission gate at call time has to DECIDE on the answer.
function EffectContractEditor({
  value,
  onChange,
  t,
}: {
  value: EffectContract
  onChange: (next: EffectContract) => void
  t: (key: string) => string
}) {
  const rollbackKind =
    value.rollback === undefined
      ? 'none'
      : typeof value.rollback === 'string'
        ? 'prose'
        : value.rollback.kind
  const setRollbackKind = (kind: string) => {
    if (kind === 'none') return onChange({ ...value, rollback: undefined })
    if (kind === 'prose') return onChange({ ...value, rollback: '' })
    if (kind === 'capability')
      return onChange({ ...value, rollback: { kind: 'capability', capability: '' } })
    if (kind === 'compensation')
      return onChange({ ...value, rollback: { kind: 'compensation', description: '' } })
    return onChange({ ...value, rollback: { kind: 'irreversible', requiresApproval: true } })
  }
  const rollbackText =
    typeof value.rollback === 'string'
      ? value.rollback
      : value.rollback?.kind === 'capability'
        ? value.rollback.capability
        : value.rollback?.kind === 'compensation'
          ? value.rollback.description
          : ''
  const setRollbackText = (text: string) => {
    if (typeof value.rollback === 'string') return onChange({ ...value, rollback: text })
    if (value.rollback?.kind === 'capability')
      return onChange({ ...value, rollback: { kind: 'capability', capability: text } })
    if (value.rollback?.kind === 'compensation')
      return onChange({ ...value, rollback: { kind: 'compensation', description: text } })
  }
  const scope = (key: string) => (
    <option key={key} value={key}>
      {t(`effectScope_${key}`)}
    </option>
  )
  return (
    <div className="space-y-2.5 rounded-md border border-border p-2.5">
      <div className="space-y-1">
        <Label>{t('effectsLabel')}</Label>
        <p className="text-[12px] text-muted-foreground">{t('effectsHint')}</p>
      </div>
      <div className="space-y-1">
        <Label>{t('sideEffectLabel')}</Label>
        <select
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
          value={value.sideEffect}
          onChange={(e) =>
            onChange({ ...value, sideEffect: e.target.value as EffectContract['sideEffect'] })
          }
        >
          {['none', 'workspace', 'external'].map(scope)}
        </select>
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="accent-primary"
          checked={value.idempotent === true}
          onChange={(e) => onChange({ ...value, idempotent: e.target.checked ? true : undefined })}
        />
        <span>{t('idempotentLabel')}</span>
      </label>
      <div className="space-y-1">
        <Label>{t('rollbackLabel')}</Label>
        <select
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
          value={rollbackKind}
          onChange={(e) => setRollbackKind(e.target.value)}
        >
          {['none', 'capability', 'compensation', 'irreversible', 'prose'].map((k) => (
            <option key={k} value={k}>
              {t(`rollbackKind_${k}`)}
            </option>
          ))}
        </select>
        {(rollbackKind === 'prose' ||
          rollbackKind === 'capability' ||
          rollbackKind === 'compensation') && (
          <Input
            value={rollbackText}
            onChange={(e) => setRollbackText(e.target.value)}
            placeholder={t(`rollbackPlaceholder_${rollbackKind}`)}
          />
        )}
      </div>
      <div className="space-y-1">
        <Label>{t('partialFailureLabel')}</Label>
        <Input
          value={value.partialFailure ?? ''}
          onChange={(e) => onChange({ ...value, partialFailure: e.target.value || undefined })}
          placeholder={t('partialFailurePlaceholder')}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>{t('readsLabel')}</Label>
          <select
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
            value={value.dataAccess?.reads ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                dataAccess: {
                  ...value.dataAccess,
                  reads: (e.target.value || undefined) as EffectContract['sideEffect'] | undefined,
                },
              })
            }
          >
            <option value="">{t('undeclared')}</option>
            {['none', 'workspace', 'external'].map(scope)}
          </select>
        </div>
        <div className="space-y-1">
          <Label>{t('egressLabel')}</Label>
          <select
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
            value={value.dataAccess?.egress ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                dataAccess: {
                  ...value.dataAccess,
                  egress: (e.target.value || undefined) as EffectContract['sideEffect'] | undefined,
                },
              })
            }
          >
            <option value="">{t('undeclared')}</option>
            {['none', 'workspace', 'external'].map(scope)}
          </select>
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">{t('egressHint')}</p>
    </div>
  )
}

function RequiredSecretsEditor({
  secrets,
  onChange,
  t,
}: {
  secrets: RequiredSecret[]
  onChange: (s: RequiredSecret[]) => void
  t: (key: string) => string
}) {
  const update = (i: number, patch: Partial<RequiredSecret>) =>
    onChange(secrets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  return (
    <div className="space-y-1.5">
      <Label>{t('requiredSecrets')}</Label>
      <p className="text-[12px] text-muted-foreground">{t('requiredSecretsHint')}</p>
      {secrets.map((s, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={s.name}
            onChange={(e) => update(i, { name: e.target.value })}
            placeholder="API_KEY"
            className="font-mono text-[12px]"
          />
          <Input
            value={s.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder={t('secretDescPlaceholder')}
            className="text-[12px]"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onChange(secrets.filter((_, idx) => idx !== i))}
            aria-label={t('remove')}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onChange([...secrets, { name: '', description: '' }])}
      >
        <Plus />
        {t('addSecret')}
      </Button>
    </div>
  )
}
