'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  Boxes,
  Check,
  CircleAlert,
  CircleCheck,
  Code2,
  Container,
  GitCompare,
  Globe,
  History,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Users,
  Zap,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { VersionTagsEditor } from '@/features/version-tags'
import {
  isBuiltInCapability,
  type Capability,
  type CapabilityImageClass,
  type CapabilitySpec,
  type CapabilitySpecDiff,
  type CapabilityType,
  type CapabilityVersions,
  type CapabilityVisibility,
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
import { Markdown } from '@/shared/ui/markdown'
import { ResetFiltersButton } from '@/shared/ui/reset-filters-button'
import { SkillDocs } from '@/shared/ui/skill-docs'
import { StatCard } from '@/shared/ui/stat-card'

import { adoptCapabilityAction, unadoptCapabilityAction } from '../api/adopt-capability'
import {
  adoptEnvironmentAction,
  unadoptEnvironmentAction,
  verifyAdoptedEnvironmentAction,
} from '../api/adopt-environment'
import {
  diffCapabilityVersionsAction,
  loadCapabilityVersionAction,
  loadCapabilityVersionsAction,
} from '../api/capability-versions'
import { deleteCapabilityVersionAction, saveCapabilityAction } from '../api/manage-capabilities'
import {
  listImageTagsAction,
  probeCapabilityMcpAction,
  validateCapabilityAction,
} from '../api/wizard-tools'
import { CodeTryPanel } from './code-try-panel'
import { ReachDialog, VisibilityPicker, WorkspacePicker } from './reach-controls'

// capability 의 필요 시크릿(채택 시 내 시크릿으로 바인딩). skill 은 없음.
function requiredSecretsOf(c: Capability): RequiredSecret[] {
  if (c.spec.type === 'mcp' || c.spec.type === 'code') return c.spec.requiredSecrets
  return []
}
// 이 capability 가 write(변경) 도구를 제공하는가 — 채택 시 enableWrite 옵트인 대상.
function offersWrite(c: Capability): boolean {
  if (c.spec.type === 'mcp') return c.spec.write
  if (c.spec.type === 'code') return !c.spec.isReadOnly
  return false
}
const capKey = (c: { tenant: string; id: string }): string => `${c.tenant}/${c.id}`

type Author = { name: string; avatarUrl?: string }
type RequiredSecret = { name: string; description: string }

const TYPE_ICON: Record<CapabilityType, typeof Boxes> = {
  mcp: Boxes,
  code: Code2,
  skill: Sparkles,
  environment: Container,
}
const VIS_ICON: Record<CapabilityVisibility, typeof Lock> = {
  private: Lock,
  workspace: Users,
  subset: Share2,
  public: Globe,
}
// 뷰어 기준 이미지 분류 배지 톤 — workspace/external=풀 가능, local/unqualified=풀 보장 없음(경고).
const IMG_CLASS_TONE: Record<CapabilityImageClass, 'success' | 'info' | 'warning'> = {
  workspace: 'success',
  external: 'info',
  local: 'warning',
  unqualified: 'warning',
}

type StoreVariant = 'catalog' | 'mine'

// Store — 매니지드/공개 발행된 capability 카탈로그. 하네스·데이터셋 목록과 같은 행 레이아웃(스탯 + 필터 + 행) 위에
// 얹고, 상세는 제자리 확장이 아니라 Dialog 로 띄운다(다른 컬럼 위젯을 밀지 않게). variant='catalog' 는 공개 목록만
// (가져옴/채택 여부를 행에 표시), variant='mine' 는 내 워크스페이스가 발행한 것(편집/공개범위/삭제 관리 + 발행). 매니지드
// (첫당사자) 항목은 "기본 제공"이 아니라 스토어가 매니지드하는 것 → 배지 + 채택/가져오기 버튼으로 노출한다.
export function CapabilityStore({
  items,
  variant,
  authors,
  canWrite,
  canAdopt,
  canImportEnvironment,
  adoptedKeys,
  adoptedEnvironments,
  secretNames,
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
  canAdopt: boolean
  canImportEnvironment: boolean
  adoptedKeys: string[]
  adoptedEnvironments: AdoptedEnvironment[]
  secretNames: string[]
  myWorkspaces: { id: string; name: string }[]
  imageRegistries: { name: string; host: string }[]
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  allowMemberPublicPublish: boolean
}) {
  const t = useTranslations('capabilityStore')
  // 클라이언트 페이지네이션 — 큰 카탈로그에서 한 번에 렌더할 행 수(더 보기로 증가). 필터 변경 시 리셋.
  const PAGE = 24
  const [visibleCount, setVisibleCount] = useState(PAGE)
  const [editing, setEditing] = useState<Capability | 'new' | null>(null)
  const [reaching, setReaching] = useState<Capability | null>(null)
  const [confirming, setConfirming] = useState<Capability | null>(null)
  const [adopting, setAdopting] = useState<Capability | null>(null)
  // 상세 Dialog 로 띄울 대상(제자리 확장 대체).
  const [detail, setDetail] = useState<Capability | null>(null)
  const [pending, startTransition] = useTransition()

  // 필터 — 하네스/데이터셋 목록과 동일한 지속 필터(검색·종류·상태·정렬). 워크스페이스 + variant 별로 기억.
  const FILTER_DEFAULTS = { query: '', type: 'all', status: 'all', sort: 'recent' }
  const { values, set, reset, dirty } = usePersistentFilters(
    `store:${variant}:${currentWorkspace}`,
    FILTER_DEFAULTS
  )
  const { query, type, status, sort } = values

  const adopted = useMemo(() => new Set(adoptedKeys), [adoptedKeys])
  // 가져온(import) 환경 이미지 — source/id → 인벤토리 항목(사용가능 검증 상태). environment 의 "가져옴/가져오기"용.
  const adoptedEnvMap = useMemo(
    () => new Map(adoptedEnvironments.map((e) => [`${e.source}/${e.id}`, e])),
    [adoptedEnvironments]
  )
  // 이미 워크스페이스에 있는가 — 환경은 가져옴(import), 그 외는 채택(adopt).
  const inWorkspace = useCallback(
    (c: Capability): boolean =>
      c.spec.type === 'environment' ? adoptedEnvMap.has(capKey(c)) : adopted.has(capKey(c)),
    [adopted, adoptedEnvMap]
  )

  // public 발행 가능? admin 은 항상, 멤버는 인스턴스 정책이 열려 있을 때. (서버가 최종 강제 — 여기선 UX 게이팅)
  const canPublishPublic = isAdmin || allowMemberPublicPublish
  // 관리 메뉴(편집/공개범위/삭제)는 내 발행(mine) 뷰에서 + 매니지드가 아니고 + 생성자/admin 일 때만. 카탈로그는 브라우즈 전용.
  const canManage = (c: Capability) =>
    variant === 'mine' && !isBuiltInCapability(c) && (c.createdBy === currentSubject || isAdmin)
  const authorOf = (createdBy: string): Author => {
    const a = authors[createdBy]
    return {
      name: a?.name ?? fmtSubject(createdBy),
      ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
    }
  }

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = items.filter((c) => {
      if (type !== 'all' && c.spec.type !== type) return false
      if (status === 'adopted' && !inWorkspace(c)) return false
      if (status === 'not' && inWorkspace(c)) return false
      return (
        q.length === 0 ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.tags.some((tag) => tag.toLowerCase().includes(q))
      )
    })
    // 매니지드(카탈로그의 얼굴)를 위로, 그다음 선택한 정렬. recent=발행 최신, name=이름, type=종류.
    return [...filtered].sort((a, b) => {
      if (isBuiltInCapability(a) !== isBuiltInCapability(b)) return isBuiltInCapability(a) ? -1 : 1
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'type')
        return a.spec.type.localeCompare(b.spec.type) || a.name.localeCompare(b.name)
      return b.createdAt.localeCompare(a.createdAt) // recent
    })
  }, [items, query, type, status, sort, inWorkspace])

  // 필터가 바뀌면 페이지네이션을 처음으로 되돌린다.
  useEffect(() => setVisibleCount(PAGE), [query, type, status, sort])
  const visible = list.slice(0, visibleCount)

  const adoptedCount = useMemo(() => items.filter(inWorkspace).length, [items, inWorkspace])
  const managedCount = useMemo(() => items.filter(isBuiltInCapability).length, [items])

  const del = (c: Capability) =>
    startTransition(async () => {
      const r = await deleteCapabilityVersionAction(c.id, c.version)
      if (r.ok) toast.success(t('deleted', { name: c.name }))
      else toast.error(r.error ?? t('deleteError'))
      setConfirming(null)
    })

  // 채택 — 필요 시크릿/쓰기 옵션이 있으면 다이얼로그로 바인딩을 받고, 없으면 바로 채택.
  const startAdopt = (c: Capability) => {
    if (requiredSecretsOf(c).length > 0 || offersWrite(c)) setAdopting(c)
    else adopt(c, {}, false)
  }
  const adopt = (c: Capability, secretBindings: Record<string, string>, enableWrite: boolean) =>
    startTransition(async () => {
      const r = await adoptCapabilityAction({
        source: c.tenant,
        id: c.id,
        version: c.version,
        secretBindings,
        enableWrite,
      })
      if (r.ok) toast.success(t('adopted', { name: c.name }))
      else toast.error(r.error ?? t('adoptError'))
      setAdopting(null)
    })
  const unadopt = (c: Capability) =>
    startTransition(async () => {
      const r = await unadoptCapabilityAction(c.tenant, c.id)
      if (r.ok) toast.success(t('removed', { name: c.name }))
      else toast.error(r.error ?? t('adoptError'))
    })

  // environment 가져오기/해제 — 워크스페이스 인벤토리에 넣고, 넣을 때 pull 가능성을 검증한다(warn-not-block).
  const importEnv = (c: Capability) =>
    startTransition(async () => {
      const r = await adoptEnvironmentAction({ source: c.tenant, id: c.id, version: c.version })
      if (!r.ok) toast.error(r.error ?? t('importError'))
      else if (r.environment.verify?.pullable === false)
        toast.warning(t('importedNotPullable', { name: c.name }))
      else toast.success(t('imported', { name: c.name }))
    })
  const removeEnv = (c: Capability) =>
    startTransition(async () => {
      const r = await unadoptEnvironmentAction(c.tenant, c.id)
      if (!r.ok) toast.error(r.error ?? t('unimportError'))
      else toast.success(t('unimported', { name: c.name }))
    })
  const reverifyEnv = (e: AdoptedEnvironment) =>
    startTransition(async () => {
      const r = await verifyAdoptedEnvironmentAction(e.source, e.id)
      if (!r.ok) toast.error(r.error ?? t('reverifyError'))
      else if (r.environment.verify?.pullable === false)
        toast.warning(t('importedNotPullable', { name: e.name ?? e.id }))
      else toast.success(t('reverified'))
    })

  const typeOptions = [
    { value: 'all', label: t('typeLabel') },
    { value: 'mcp', label: t('type_mcp') },
    { value: 'code', label: t('type_code') },
    { value: 'skill', label: t('type_skill') },
    { value: 'environment', label: t('type_environment') },
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
          label={t('statAdopted')}
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
        <Combobox
          options={statusOptions}
          value={status}
          onChange={(v) => set('status', v)}
          className="w-[150px]"
          aria-label={t('statusLabel')}
        />
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
        <EmptyState
          icon={<Boxes />}
          title={t(variant === 'mine' ? 'mineEmptyTitle' : 'emptyTitle')}
          hint={t(variant === 'mine' ? 'mineEmptyHint' : 'emptyHint')}
          {...(variant === 'mine' && canWrite
            ? { action: <Button onClick={() => setEditing('new')}>{t('publish')}</Button> }
            : {})}
        />
      ) : (
        <div className="space-y-2">
          {visible.map((c) => {
            const author = authorOf(c.createdBy)
            const TypeIcon = TYPE_ICON[c.spec.type]
            const VisIcon = VIS_ICON[c.visibility]
            const managed = isBuiltInCapability(c)
            const here = inWorkspace(c)
            const isEnv = c.spec.type === 'environment'
            return (
              <div
                key={capKey(c)}
                role="button"
                tabIndex={0}
                onClick={() => setDetail(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setDetail(c)
                  }
                }}
                className="group block cursor-pointer rounded-lg border bg-card p-3.5 shadow-raise outline-none transition-colors hover:border-border-strong hover:bg-elevated focus-visible:border-border-strong"
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
                            {isEnv ? t('importedBadge') : t('adoptedBadge')}
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
                  {/* 우측 액션 영역 — 카드(role=button)가 상세를 열므로, 여기 버튼 클릭이 카드 열림으로 버블링되지 않게 막는다. */}
                  <div
                    className="flex shrink-0 items-center gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canManage(c) && (
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
                    )}
                    {isEnv
                      ? canImportEnvironment &&
                        (here ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => removeEnv(c)}
                          >
                            <Check />
                            {t('importedRemove')}
                          </Button>
                        ) : (
                          <Button size="sm" disabled={pending} onClick={() => importEnv(c)}>
                            <Plus />
                            {t('import')}
                          </Button>
                        ))
                      : canAdopt &&
                        (here ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => unadopt(c)}
                          >
                            <Check />
                            {t('adoptedRemove')}
                          </Button>
                        ) : (
                          <Button size="sm" disabled={pending} onClick={() => startAdopt(c)}>
                            <Plus />
                            {t('adopt')}
                          </Button>
                        ))}
                    <Avatar
                      name={author.name}
                      url={author.avatarUrl}
                      size="sm"
                      className="rounded-full"
                    />
                  </div>
                </div>
              </div>
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

      {detail !== null && (
        <CapabilityDetailDialog
          capability={detail}
          variant={variant}
          currentWorkspace={currentWorkspace}
          currentSubject={currentSubject}
          isAdmin={isAdmin}
          inWorkspace={inWorkspace(detail)}
          adoptedEnv={adoptedEnvMap.get(capKey(detail))}
          canAdopt={canAdopt}
          canImportEnvironment={canImportEnvironment}
          pending={pending}
          onClose={() => setDetail(null)}
          onAdopt={() => startAdopt(detail)}
          onUnadopt={() => unadopt(detail)}
          onImport={() => importEnv(detail)}
          onRemoveEnv={() => removeEnv(detail)}
          onReverifyEnv={reverifyEnv}
        />
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

      {adopting !== null && (
        <AdoptDialog
          capability={adopting}
          secretNames={secretNames}
          pending={pending}
          onClose={() => setAdopting(null)}
          onAdopt={(bindings, enableWrite) => adopt(adopting, bindings, enableWrite)}
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

// 행 메타 — 종류별 한 줄 요약(mcp=제공 도구, code=언어+읽기전용, environment=이미지 참조) + 태그 몇 개. 없으면 렌더 안 함.
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

// 상세 Dialog — 카드 클릭 시 전체 스펙을 모달로 띄운다(제자리 확장이 아니라, 다른 컬럼에 영향 없이). 헤더(이름/종류/버전/
// 배지) + CapabilityDetail(버전 패널 + 스펙 본문) + 푸터 액션(채택/가져오기, environment 는 pull 상태·재검증 포함).
function CapabilityDetailDialog({
  capability,
  variant,
  currentWorkspace,
  currentSubject,
  isAdmin,
  inWorkspace,
  adoptedEnv,
  canAdopt,
  canImportEnvironment,
  pending,
  onClose,
  onAdopt,
  onUnadopt,
  onImport,
  onRemoveEnv,
  onReverifyEnv,
}: {
  capability: Capability
  variant: StoreVariant
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  inWorkspace: boolean
  adoptedEnv?: AdoptedEnvironment
  canAdopt: boolean
  canImportEnvironment: boolean
  pending: boolean
  onClose: () => void
  onAdopt: () => void
  onUnadopt: () => void
  onImport: () => void
  onRemoveEnv: () => void
  onReverifyEnv: (e: AdoptedEnvironment) => void
}) {
  const t = useTranslations('capabilityStore')
  const TypeIcon = TYPE_ICON[capability.spec.type]
  const VisIcon = VIS_ICON[capability.visibility]
  const managed = isBuiltInCapability(capability)
  const isEnv = capability.spec.type === 'environment'
  const verify = adoptedEnv?.verify
  return (
    <Dialog open onClose={onClose} align="top" className="max-w-2xl">
      <div className="max-h-[85vh] space-y-4 overflow-y-auto p-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <TypeIcon className="size-5 shrink-0 text-primary" />
            <span className="min-w-0 truncate font-mono text-[15px] font-[560]">
              {capability.name}
            </span>
            <Badge tone="outline" className="shrink-0">
              {t(`type_${capability.spec.type}`)}
            </Badge>
            {managed && (
              <Badge tone="info" className="shrink-0 gap-1">
                <Sparkles className="size-3" />
                {t('managed')}
              </Badge>
            )}
            {variant === 'mine' && (
              <Badge
                tone={capability.visibility === 'private' ? 'outline' : 'info'}
                className="shrink-0 gap-1"
              >
                <VisIcon className="size-3" />
                {t(`vis_${capability.visibility}`)}
              </Badge>
            )}
            <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
              {capability.version}
            </code>
          </div>
          <p className="text-[13px] text-muted-foreground">{capability.description}</p>
          {managed && <p className="text-[12px] text-muted-foreground">{t('managedHint')}</p>}
        </div>

        <CapabilityDetail
          capability={capability}
          currentWorkspace={currentWorkspace}
          currentSubject={currentSubject}
          isAdmin={isAdmin}
        />

        {isEnv && inWorkspace && verify && (
          <div className="flex items-center gap-3">
            <Badge tone={verify.pullable ? 'success' : 'warning'}>
              {verify.pullable
                ? t('importedBadge')
                : t(
                    verify.reason === 'auth'
                      ? 'verifyAuth'
                      : verify.reason === 'not-found'
                        ? 'verifyNotFound'
                        : 'verifyUnreachable'
                  )}
            </Badge>
            {canImportEnvironment && adoptedEnv && (
              <button
                type="button"
                className="text-[12px] font-[510] text-link transition-colors hover:text-foreground"
                disabled={pending}
                onClick={() => onReverifyEnv(adoptedEnv)}
              >
                {t('reverify')}
              </button>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          {inWorkspace ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-success">
              <CircleCheck className="size-4" />
              {t('detailAdopted')}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('close')}
            </Button>
            {isEnv
              ? canImportEnvironment &&
                (inWorkspace ? (
                  <Button variant="secondary" size="sm" disabled={pending} onClick={onRemoveEnv}>
                    <Check />
                    {t('importedRemove')}
                  </Button>
                ) : (
                  <Button size="sm" disabled={pending} onClick={onImport}>
                    <Plus />
                    {t('import')}
                  </Button>
                ))
              : canAdopt &&
                (inWorkspace ? (
                  <Button variant="secondary" size="sm" disabled={pending} onClick={onUnadopt}>
                    <Check />
                    {t('adoptedRemove')}
                  </Button>
                ) : (
                  <Button size="sm" disabled={pending} onClick={onAdopt}>
                    <Plus />
                    {t('adopt')}
                  </Button>
                ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

// 발행/편집 다이얼로그. 새 capability 면 id + 타입 선택 + 공개범위 선택; 편집이면 콘텐츠만(reach 는 ⋯ → reach 변경).
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
  // 두 transport: 원격 HTTP url(default) 또는 컨테이너 이미지(stdio). 편집 시 image 가 있으면 이미지 모드.
  const [mcpImageMode, setMcpImageMode] = useState(!!mcp?.image)
  const [url, setUrl] = useState(mcp?.url ?? '')
  const [image, setImage] = useState(mcp?.image ?? '')
  const [imageArgs, setImageArgs] = useState((mcp?.args ?? []).join(' '))
  const [provides, setProvides] = useState((mcp?.provides ?? []).join(', '))
  const [mcpWrite, setMcpWrite] = useState(mcp?.write ?? false)
  // mcp 연결 테스트(probe) — 테스트 전용 토큰(미저장) + 결과(도달성 + 발견 도구, provides 자동채움).
  const [probeToken, setProbeToken] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ProbeCapabilityMcpResult | null>(null)
  // 저장 전 검증(dry-run) 결과 — 전 종류 공통(footer 에 인라인 표시).
  const [validateResult, setValidateResult] = useState<ValidateCapabilityResult | null>(null)
  // code
  const code = capability?.spec.type === 'code' ? capability.spec : undefined
  const [language, setLanguage] = useState<'python' | 'node'>(code?.language ?? 'python')
  const [source, setSource] = useState(code?.code ?? '')
  const [params, setParams] = useState(code ? JSON.stringify(code.parametersSchema, null, 2) : '{}')
  const [isReadOnly, setIsReadOnly] = useState(code?.isReadOnly ?? true)
  // 워크드 예제(행 편집: 이름/입력 JSON/노트) — 스토어 상세·try 실행·에이전트 tool description 3중 용도.
  const [codeExamples, setCodeExamples] = useState<{ name: string; input: string; note: string }[]>(
    (code?.examples ?? []).map((e) => ({
      name: e.name ?? '',
      input: JSON.stringify(e.input),
      note: e.note ?? '',
    }))
  )
  // skill · environment 공용 — 둘 다 instructions 본문을 가진다(스킬=절차, 환경=구성 설명).
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
  // environment 이미지 태그 피커 — 워크스페이스 레지스트리의 repository 태그를 조회해 image ref(host/repo:tag)를 조립.
  const [tagRegistry, setTagRegistry] = useState(imageRegistries[0]?.name ?? '')
  const [tagRepo, setTagRepo] = useState('')
  const [tagLoading, setTagLoading] = useState(false)
  const [imageTags, setImageTags] = useState<string[] | null>(null)

  const initialSecrets: RequiredSecret[] = mcp?.requiredSecrets ?? code?.requiredSecrets ?? []
  const [secrets, setSecrets] = useState<RequiredSecret[]>(initialSecrets)

  const [pending, startTransition] = useTransition()

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
      // 예제 행 → spec.examples. 완전히 빈 행은 건너뛰고, 입력이 JSON 오브젝트가 아니면 저장을 막는다.
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
      }
    }
    if (type === 'environment') {
      // preset 은 토폴로지 서브어휘 JSON — 편집은 raw JSON(overrides JSON textarea 선례), 최종 검증은 컨트롤플레인.
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
    // 부속 파일은 위저드가 저작하지 않는다 — 기존 스킬을 편집할 땐 원본 파일셋을 보존(안 그러면 편집이 파일을 지운다).
    return { type: 'skill', instructions, files: skill?.files ?? [] }
  }

  // mcp 연결 테스트 — URL(+ 선택 토큰)로 test-connect 하고 도구를 발견한다. 실패는 결과(reachable:false)로 표시.
  const runProbe = () => {
    setProbing(true)
    setProbeResult(null)
    void probeCapabilityMcpAction(url.trim(), probeToken.trim() || undefined).then((r) => {
      setProbing(false)
      if (r.ok && r.result) setProbeResult(r.result)
      else toast.error(r.error ?? t('probeError'))
    })
  }
  // 발견한 도구 이름을 provides 로 채운다(수동 입력 대체).
  const fillProvides = () => {
    if (probeResult) setProvides(probeResult.tools.map((tool) => tool.name).join(', '))
  }

  // environment 이미지 태그 조회 — repository(+ 선택 레지스트리)의 태그 목록.
  const runListTags = () => {
    setTagLoading(true)
    setImageTags(null)
    void listImageTagsAction(tagRepo.trim(), tagRegistry || undefined).then((r) => {
      setTagLoading(false)
      if (r.ok && r.tags) setImageTags(r.tags)
      else toast.error(r.error ?? t('tagsError'))
    })
  }
  // 태그를 고르면 host/repository:tag 로 image ref 를 조립한다. (mutable 태그 경고는 저장/검증에서 안내)
  const pickTag = (tag: string) => {
    const host = imageRegistries.find((reg) => reg.name === tagRegistry)?.host
    setEnvImage(`${host ? `${host}/` : ''}${tagRepo.trim()}:${tag}`)
  }

  // 저장 전 검증(dry-run) — 새 capability/새 버전 여부 + 예측 버전 + 이미지 경고를 인라인으로 보여준다.
  const runValidate = () =>
    startTransition(async () => {
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
    })

  const save = () =>
    startTransition(async () => {
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
        // 이미지 분류 경고(warn-not-block) — 발행은 성공, 풀 보장/재현성만 주의 환기.
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
    })

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

        {/* 타입 — 새 capability 만 선택 가능(콘텐츠 정체성) */}
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
            {/* transport 토글 — 원격 HTTP url vs 컨테이너 이미지(stdio, `docker run -i`) */}
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
                {/* 연결 테스트 — URL(+선택 토큰)로 test-connect 하고 도구를 발견 → provides 자동채움 */}
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
            {/* 워크드 예제 — 이 도구가 무엇을 하는지 입력 형태로 보여준다(상세 표시·try·tool description 3중 용도) */}
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
            {/* 발행 전 검증 — check(구문)와 run(예제 실행). 코드만 보고 발행하지 않는다. */}
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
            {/* 이미지 태그 피커 — 워크스페이스 레지스트리의 repository 태그를 조회해 image ref 를 조립(수동 타이핑 대체) */}
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

        {/* 저장 전 검증(dry-run) 결과 — 새 capability/새 버전 여부 + 예측 버전 + 스펙 오류/이미지 경고 */}
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

// 채택 다이얼로그 — 필요 시크릿을 내 워크스페이스 시크릿 이름으로 바인딩 + 쓰기 옵트인. 그 다음 에이전트에 pin 추가.
function AdoptDialog({
  capability,
  secretNames,
  pending,
  onClose,
  onAdopt,
}: {
  capability: Capability
  secretNames: string[]
  pending: boolean
  onClose: () => void
  onAdopt: (secretBindings: Record<string, string>, enableWrite: boolean) => void
}) {
  const t = useTranslations('capabilityStore')
  const required = requiredSecretsOf(capability)
  const write = offersWrite(capability)
  const [bindings, setBindings] = useState<Record<string, string>>(
    Object.fromEntries(required.map((s) => [s.name, s.name]))
  )
  const [enableWrite, setEnableWrite] = useState(false)

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <div>
          <h3 className="text-sm font-medium">{t('adoptTitle', { name: capability.name })}</h3>
          {capability.spec.type === 'code' && (
            <p className="mt-1 text-[12px] text-muted-foreground">{t('adoptCodeNote')}</p>
          )}
        </div>
        {required.length > 0 && (
          <div className="space-y-2">
            <Label>{t('bindSecrets')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('bindSecretsHint')}</p>
            {required.map((s) => (
              <div key={s.name} className="space-y-1">
                <div className="text-[12px]">
                  <span className="font-mono">{s.name}</span>
                  {s.description ? (
                    <span className="text-muted-foreground"> — {s.description}</span>
                  ) : null}
                </div>
                <Input
                  list="cap-secret-names"
                  value={bindings[s.name] ?? ''}
                  onChange={(e) => setBindings((b) => ({ ...b, [s.name]: e.target.value }))}
                  placeholder={s.name}
                  className="font-mono text-[12px]"
                />
              </div>
            ))}
            <datalist id="cap-secret-names">
              {secretNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
        )}
        {write && (
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="accent-primary"
              checked={enableWrite}
              onChange={(e) => setEnableWrite(e.target.checked)}
            />
            <span>{t('enableWrite')}</span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => onAdopt(bindings, enableWrite)}>
            {pending ? t('saving') : t('adopt')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// capability 상세(제자리 드릴인) — mcp/code/skill 의 전체 스펙을 카드 안에서 읽기전용으로 노출한다(라우트 미사용).
function CapabilityDetail({
  capability,
  currentWorkspace,
  currentSubject,
  isAdmin,
}: {
  capability: Capability
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
}) {
  const t = useTranslations('capabilityStore')
  // 크로스테넌트 public/subset 카드는 오너 워크스페이스를 source 로 넘겨 버전을 조회한다. 내 워크스페이스 것이면 생략.
  const source = capability.tenant !== currentWorkspace ? capability.tenant : undefined
  const builtin = isBuiltInCapability(capability)
  // 버전 태그 편집 = 내 워크스페이스 소유 + 버전 생성자-or-admin(서버가 최종 강제). 빌트인/크로스테넌트는 읽기전용.
  const canManageVersions =
    !builtin && source === undefined && (capability.createdBy === currentSubject || isAdmin)
  // 상세에 표시할 레코드 — 최신(넘어온 capability) 또는 스위처로 고른 과거 버전.
  const [shown, setShown] = useState<Capability>(capability)
  const s = shown.spec
  const secrets = s.type === 'mcp' || s.type === 'code' ? s.requiredSecrets : []
  return (
    <div className="mt-2 space-y-3 rounded-md border border-border bg-secondary/30 p-3 text-[12.5px]">
      {!builtin && (
        <CapabilityVersionsPanel
          id={capability.id}
          source={source}
          latestVersion={capability.version}
          shownVersion={shown.version}
          canManage={canManageVersions}
          onShowVersion={setShown}
        />
      )}
      {s.type === 'mcp' && (
        <>
          <div className="space-y-0.5">
            <p className="text-[11px] font-[510] text-muted-foreground">
              {t(s.image ? 'mcpImage' : 'mcpUrl')}
            </p>
            <code className="block break-all font-mono text-foreground">
              {s.image ? `${s.image}${s.args.length > 0 ? ` ${s.args.join(' ')}` : ''}` : s.url}
            </code>
          </div>
          {s.provides.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {s.provides.map((p) => (
                <Badge key={p} tone="neutral">
                  {p}
                </Badge>
              ))}
            </div>
          )}
          {s.write && <Badge tone="warning">{t('mcpWrite')}</Badge>}
        </>
      )}
      {s.type === 'code' && (
        <>
          <div className="flex flex-wrap gap-1">
            <Badge tone="outline">{s.language}</Badge>
            <Badge tone={s.isReadOnly ? 'success' : 'warning'}>
              {t(s.isReadOnly ? 'codeReadOnly' : 'codeWrites')}
            </Badge>
          </div>
          <CodeEditor
            value={s.code}
            language={s.language}
            readOnly
            minHeight="120px"
            maxHeight="320px"
            aria-label={t('code')}
          />
          {Object.keys(s.parametersSchema).length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[11px] font-[510] text-muted-foreground">{t('params')}</p>
              <pre className="max-h-40 overflow-auto rounded-md bg-secondary/50 p-2 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(s.parametersSchema, null, 2)}
              </pre>
            </div>
          )}
          {s.examples.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-[510] text-muted-foreground">{t('examplesLabel')}</p>
              {s.examples.map((e, i) => (
                <div key={i} className="text-[12px] text-muted-foreground">
                  {e.name && <span className="font-[510] text-foreground">{e.name}: </span>}
                  <code className="break-all font-mono">{JSON.stringify(e.input)}</code>
                  {e.note ? ` — ${e.note}` : ''}
                </div>
              ))}
            </div>
          )}
          {/* 예제로 직접 실행 — 코드만 읽고 채택하지 않는다(타 워크스페이스 코드는 격리 런타임에서만; 서버가 판정). */}
          <CodeTryPanel
            showCheck={false}
            buildTarget={() => ({
              ref: { source: shown.tenant, id: shown.id, version: shown.version },
            })}
            initialInput={s.examples[0] ? JSON.stringify(s.examples[0].input, null, 2) : '{}'}
          />
        </>
      )}
      {s.type === 'skill' && (
        // 멀티문서 스킬 뷰어(SKILL.md + 부속 파일 탭) — 스킬 관리 상세와 동일한 공용 뷰어를 공유(v1 단일 문서 나열 대체).
        <SkillDocs instructions={s.instructions} files={s.files} />
      )}
      {s.type === 'environment' && (
        <div className="space-y-3">
          {/* 이미지 참조 + 뷰어 기준 분류 + 벤치마크/OS 요약 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="min-w-0 truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
              {s.image}
            </code>
            {shown.imageClass && (
              <Badge tone={IMG_CLASS_TONE[shown.imageClass]}>
                {t(`imgClass_${shown.imageClass}`)}
              </Badge>
            )}
            {s.contents?.benchmark && <Badge tone="outline">{s.contents.benchmark}</Badge>}
            {s.contents?.os && (
              <Badge tone="outline">
                {s.contents.os}
                {s.contents.arch ? `/${s.contents.arch}` : ''}
              </Badge>
            )}
          </div>
          <div>
            <p className="text-[11px] font-[510] text-muted-foreground">{t('envInstructions')}</p>
            {/* instructions 는 마크다운 문서 — 렌더링해 보여준다 */}
            <Markdown content={s.instructions} className="mt-1 text-[12.5px] leading-relaxed" />
          </div>
          {s.preset && (
            <div>
              <p className="text-[11px] font-[510] text-muted-foreground">{t('envPreset')}</p>
              <pre className="mt-1 overflow-x-auto font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                {JSON.stringify(s.preset, null, 2)}
              </pre>
            </div>
          )}
          {s.contents && s.contents.packages.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {s.contents.packages.map((p) => (
                <Badge key={p} tone="neutral">
                  {p}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
      {secrets.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[11px] font-[510] text-muted-foreground">{t('requiredSecrets')}</p>
          {secrets.map((secret) => (
            <div key={secret.name} className="text-muted-foreground">
              <span className="font-mono text-foreground">{secret.name}</span>
              {secret.description ? ` — ${secret.description}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 버전 관리 패널(레지스트리 엔티티 패리티) — 상세 드릴인 안의 버전 목록·스위처·버전 태그·구조 diff. 드릴인은 라우트가
// 아니라 클라이언트 상태라 열 때 온디맨드로 로드한다. 내 워크스페이스 소유 + 생성자/admin 이면 태그 편집(canManage), 아니면
// 읽기전용. source=크로스테넌트 public/subset 오너(내 것이면 생략).
function CapabilityVersionsPanel({
  id,
  source,
  latestVersion,
  shownVersion,
  canManage,
  onShowVersion,
}: {
  id: string
  source?: string
  latestVersion: string
  shownVersion: string
  canManage: boolean
  onShowVersion: (record: Capability) => void
}) {
  const t = useTranslations('capabilityStore')
  const [data, setData] = useState<CapabilityVersions | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [switching, startSwitch] = useTransition()
  const [base, setBase] = useState('')
  const [candidate, setCandidate] = useState('')
  const [diff, setDiff] = useState<CapabilitySpecDiff | null>(null)
  const [diffing, startDiff] = useTransition()
  const [diffError, setDiffError] = useState<string>()

  const reload = useCallback(() => {
    setLoading(true)
    loadCapabilityVersionsAction(id, source).then((r) => {
      if (r.ok) {
        setData(r.data)
        setError(undefined)
      } else {
        setError(r.error)
      }
      setLoading(false)
    })
  }, [id, source])
  useEffect(() => {
    reload()
  }, [reload])

  // 스위처 — 고른 버전의 전체 레코드를 불러 상세 spec 을 교체.
  const showVersion = (version: string) => {
    if (version === shownVersion) return
    startSwitch(async () => {
      const r = await loadCapabilityVersionAction(id, version, source)
      if (r.ok) onShowVersion(r.data)
      else setError(r.error)
    })
  }

  const runDiff = () => {
    if (!base || !candidate) return
    startDiff(async () => {
      const r = await diffCapabilityVersionsAction(id, base, candidate, source)
      if (r.ok) {
        setDiff(r.data)
        setDiffError(undefined)
      } else {
        setDiff(null)
        setDiffError(r.error)
      }
    })
  }

  if (loading) return <p className="text-[11px] text-muted-foreground">{t('versionsLoading')}</p>
  if (error) return <p className="text-[11px] text-[var(--color-danger)]">{error}</p>
  if (!data || data.versions.length === 0) return null

  const descending = [...data.versions].reverse() // 최신 먼저

  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-[510] text-muted-foreground">
          <History className="size-3.5" />
          {t('versionsLabel')}
        </span>
        <Combobox
          options={descending.map((v) => ({
            value: v,
            label: v === latestVersion ? `${v} · ${t('latest')}` : v,
            ...((data.versionTags[v]?.length ?? 0) > 0
              ? { hint: data.versionTags[v]?.join(' · ') }
              : {}),
          }))}
          value={shownVersion}
          onChange={showVersion}
          disabled={switching}
          className="w-[200px]"
          aria-label={t('versionsLabel')}
        />
        {switching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {(canManage || (data.versionTags[shownVersion]?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-faint">{t('versionTagsLabel')}</span>
          <VersionTagsEditor
            entity="capability"
            id={id}
            version={shownVersion}
            tags={data.versionTags[shownVersion] ?? []}
            canEdit={canManage}
            onSaved={reload}
          />
        </div>
      )}

      {data.versions.length > 1 && (
        <div className="space-y-1.5 border-t border-border/60 pt-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <GitCompare className="size-3.5 text-muted-foreground" />
            <VersionSelect
              versions={descending}
              value={base}
              placeholder={t('diffBase')}
              onChange={setBase}
            />
            <ArrowRight className="size-3 text-faint" />
            <VersionSelect
              versions={descending}
              value={candidate}
              placeholder={t('diffCandidate')}
              onChange={setCandidate}
            />
            <button
              type="button"
              disabled={!base || !candidate || diffing}
              onClick={runDiff}
              className="rounded border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {t('diffCompare')}
            </button>
            {diffing && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          {diffError && <p className="text-[11px] text-[var(--color-danger)]">{diffError}</p>}
          {diff && <CapabilityDiffView diff={diff} />}
        </div>
      )}
    </div>
  )
}

function VersionSelect({
  versions,
  value,
  placeholder,
  onChange,
}: {
  versions: string[]
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  return (
    <Combobox
      options={versions.map((v) => ({ value: v, label: v }))}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className="w-[120px]"
      aria-label={placeholder}
    />
  )
}

// 구조 diff 렌더 — 필드 경로별 before → after + added/removed/changed 톤. typeChanged(종류 재구성) 힌트.
function CapabilityDiffView({ diff }: { diff: CapabilitySpecDiff }) {
  const t = useTranslations('capabilityStore')
  if (diff.changes.length === 0)
    return <p className="text-[11px] text-muted-foreground">{t('diffNoChanges')}</p>
  const label = (change: CapabilitySpecDiff['changes'][number]['change']) =>
    change === 'added' ? t('diffAdded') : change === 'removed' ? t('diffRemoved') : t('diffChanged')
  const tone = (change: CapabilitySpecDiff['changes'][number]['change']) =>
    change === 'added' ? 'success' : change === 'removed' ? 'danger' : 'warning'
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {t('diffSummary', {
          added: diff.summary.added,
          removed: diff.summary.removed,
          changed: diff.summary.changed,
        })}
        {diff.typeChanged ? ` · ${t('diffTypeChanged')}` : ''}
      </p>
      <div className="space-y-1">
        {diff.changes.map((ch) => (
          <div
            key={ch.path}
            className="rounded border border-border/60 bg-secondary/30 p-1.5 text-[11px]"
          >
            <div className="flex items-center gap-1.5">
              <Badge tone={tone(ch.change)}>{label(ch.change)}</Badge>
              <code className="break-all font-mono text-foreground">{ch.path}</code>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
              <span className="break-all line-through decoration-[var(--color-danger)]/50">
                {ch.before}
              </span>
              <ArrowRight className="size-3 shrink-0 text-faint" />
              <span className="break-all text-foreground">{ch.after}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// 필요 시크릿 편집 — 이름 + 설명 행(추가/삭제). 채택자가 자기 시크릿으로 채운다(값 아님, 이름만).
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
