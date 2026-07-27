'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Boxes,
  Check,
  CircleAlert,
  CircleCheck,
  Code2,
  Container,
  Globe,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Sparkles,
  Trash2,
  Users,
  Zap,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type {
  Capability,
  CapabilityImageClass,
  CapabilitySpec,
  CapabilityType,
  CapabilityVisibility,
} from '@/entities/capability'
import { fmtSubject } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { adoptCapabilityAction, unadoptCapabilityAction } from '../api/adopt-capability'
import {
  deleteCapabilityVersionAction,
  saveCapabilityAction,
  setCapabilityVisibilityAction,
} from '../api/manage-capabilities'
import { probeCapabilityMcpAction, validateCapabilityAction } from '../api/wizard-tools'
import type { ProbeCapabilityMcpResult, ValidateCapabilityResult } from '@/entities/capability'

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

// The reserved owner of first-party (Everdict-authored) built-ins — mirrors contracts FIRST_PARTY_TENANT. These are
// code-defined (not DB rows), merged into the public catalog by the control plane; they can't be edited/deleted and
// are provided as defaults (managed in Settings › Agent), so the store shows them read-only with a "built-in" badge.
const BUILT_IN_TENANT = '_everdict'
const isBuiltIn = (c: { tenant: string }): boolean => c.tenant === BUILT_IN_TENANT

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

// Store — 워크스페이스가 함께 만드는 도구/스킬 카탈로그. 내 스토어(내가 볼 수 있는 것)와 공개 카탈로그를 탭으로 브라우즈하고,
// 멤버가 발행(mcp|code|skill)·편집·reach 변경·삭제한다. 채택(에이전트에 추가)은 후속 단계.
export function CapabilityStore({
  mine,
  publicCaps,
  authors,
  canWrite,
  canAdopt,
  adoptedKeys,
  secretNames,
  myWorkspaces,
  currentWorkspace,
  currentSubject,
  isAdmin,
  allowMemberPublicPublish,
}: {
  mine: Capability[]
  publicCaps: Capability[]
  authors: Record<string, Author>
  canWrite: boolean
  canAdopt: boolean
  adoptedKeys: string[]
  secretNames: string[]
  myWorkspaces: { id: string; name: string }[]
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  allowMemberPublicPublish: boolean
}) {
  const t = useTranslations('capabilityStore')
  const [tab, setTab] = useState<'mine' | 'public'>('mine')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | CapabilityType>('all')
  const [sort, setSort] = useState<'recent' | 'name' | 'type'>('recent')
  const [editing, setEditing] = useState<Capability | 'new' | null>(null)
  const [reaching, setReaching] = useState<Capability | null>(null)
  const [confirming, setConfirming] = useState<Capability | null>(null)
  const [adopting, setAdopting] = useState<Capability | null>(null)
  // environment 카드 제자리 확장(단일-오픈) — instructions + preset 을 카드 안에서 드릴인.
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const adopted = useMemo(() => new Set(adoptedKeys), [adoptedKeys])

  // public 발행 가능? admin 은 항상, 멤버는 인스턴스 정책이 열려 있을 때. (서버가 최종 강제 — 여기선 UX 게이팅)
  const canPublishPublic = isAdmin || allowMemberPublicPublish
  // built-in 은 코드정의(DB 미존재)라 편집/삭제/reach 불가 — admin 이라도 관리 메뉴를 숨긴다(setVisibility/delete 는 404).
  const canManage = (c: Capability) => !isBuiltIn(c) && (c.createdBy === currentSubject || isAdmin)
  const authorOf = (createdBy: string): Author => {
    const a = authors[createdBy]
    return {
      name: a?.name ?? fmtSubject(createdBy),
      ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
    }
  }

  const list = useMemo(() => {
    const source = tab === 'mine' ? mine : publicCaps
    const q = query.trim().toLowerCase()
    const filtered = source.filter(
      (c) =>
        (typeFilter === 'all' || c.spec.type === typeFilter) &&
        (q.length === 0 ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.tags.some((tag) => tag.toLowerCase().includes(q)))
    )
    // built-in 을 항상 위로(공개 카탈로그의 얼굴), 그다음 선택한 정렬 기준. recent=발행 최신, name=이름, type=종류.
    return [...filtered].sort((a, b) => {
      if (isBuiltIn(a) !== isBuiltIn(b)) return isBuiltIn(a) ? -1 : 1
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'type') return a.spec.type.localeCompare(b.spec.type) || a.name.localeCompare(b.name)
      return b.createdAt.localeCompare(a.createdAt) // recent
    })
  }, [tab, mine, publicCaps, query, typeFilter, sort])

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

  return (
    <div className="space-y-4">
      {canWrite && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus />
            {t('publish')}
          </Button>
        </div>
      )}

      {/* 탭 — 내 스토어 / 공개 카탈로그 */}
      <div className="flex items-center gap-1 border-b border-border">
        {(['mine', 'public'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              tab === k
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t(k === 'mine' ? 'tabMine' : 'tabPublic')}
          </button>
        ))}
      </div>

      {/* 검색 + 타입 필터 + 정렬 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="h-8 max-w-xs text-[13px]"
        />
        <div className="flex items-center gap-1">
          {(['all', 'mcp', 'code', 'skill', 'environment'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTypeFilter(k)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset transition-colors',
                typeFilter === k
                  ? 'bg-primary/10 text-primary ring-primary/30'
                  : 'text-muted-foreground ring-border hover:bg-accent'
              )}
            >
              {k === 'all' ? t('filterAll') : t(`type_${k}`)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">{t('resultCount', { count: list.length })}</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as 'recent' | 'name' | 'type')}
            aria-label={t('sortBy')}
            className="h-8 rounded-md border border-border bg-card px-2 text-[12px] text-foreground"
          >
            <option value="recent">{t('sortRecent')}</option>
            <option value="name">{t('sortName')}</option>
            <option value="type">{t('sortType')}</option>
          </select>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          {...(canWrite && tab === 'mine'
            ? { action: <Button onClick={() => setEditing('new')}>{t('publish')}</Button> }
            : {})}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {list.map((c) => {
            const author = authorOf(c.createdBy)
            const TypeIcon = TYPE_ICON[c.spec.type]
            const VisIcon = VIS_ICON[c.visibility]
            return (
              <div
                key={`${c.tenant}/${c.id}`}
                className="flex flex-col rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <TypeIcon className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 truncate font-mono text-[13px] font-medium">
                      {c.name}
                    </span>
                    <Badge tone="outline" className="shrink-0">
                      {t(`type_${c.spec.type}`)}
                    </Badge>
                    <Badge
                      tone={c.visibility === 'private' ? 'outline' : 'info'}
                      className="shrink-0 gap-1"
                    >
                      <VisIcon className="size-3" />
                      {t(`vis_${c.visibility}`)}
                    </Badge>
                    {isBuiltIn(c) && (
                      <Badge tone="success" className="shrink-0 gap-1">
                        <Sparkles className="size-3" />
                        {t('builtIn')}
                      </Badge>
                    )}
                    <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
                      {c.version}
                    </code>
                  </div>
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
                </div>

                <p className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground">
                  {c.description}
                </p>

                {/* environment — 이미지 ref + 뷰어 기준 분류 배지 + 벤치마크/OS 요약(스토어에서 이미지 정보 기본 노출)
                    + 제자리 드릴인(instructions·preset) */}
                {c.spec.type === 'environment' && (
                  <>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <code className="min-w-0 truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
                        {c.spec.image}
                      </code>
                      {c.imageClass && (
                        <Badge tone={IMG_CLASS_TONE[c.imageClass]} className="shrink-0">
                          {t(`imgClass_${c.imageClass}`)}
                        </Badge>
                      )}
                      {c.spec.contents?.benchmark && (
                        <Badge tone="outline" className="shrink-0">
                          {c.spec.contents.benchmark}
                        </Badge>
                      )}
                      {c.spec.contents?.os && (
                        <Badge tone="outline" className="shrink-0">
                          {c.spec.contents.os}
                          {c.spec.contents.arch ? `/${c.spec.contents.arch}` : ''}
                        </Badge>
                      )}
                      <button
                        type="button"
                        onClick={() => setExpandedKey(expandedKey === capKey(c) ? null : capKey(c))}
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-primary transition-colors hover:bg-primary/10"
                      >
                        {t(expandedKey === capKey(c) ? 'envHideDetail' : 'envShowDetail')}
                      </button>
                    </div>
                    {expandedKey === capKey(c) && (
                      <div className="mt-3 space-y-3 rounded-md border border-border bg-secondary/30 p-3">
                        <div>
                          <p className="text-[11px] font-[510] text-muted-foreground">
                            {t('envInstructions')}
                          </p>
                          <pre className="mt-1 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-foreground">
                            {c.spec.instructions}
                          </pre>
                        </div>
                        {c.spec.preset && (
                          <div>
                            <p className="text-[11px] font-[510] text-muted-foreground">
                              {t('envPreset')}
                            </p>
                            <pre className="mt-1 overflow-x-auto font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                              {JSON.stringify(c.spec.preset, null, 2)}
                            </pre>
                          </div>
                        )}
                        {c.spec.contents && c.spec.contents.packages.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1">
                            {c.spec.contents.packages.map((p) => (
                              <Badge key={p} tone="neutral">
                                {p}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                  <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
                    <Avatar
                      name={author.name}
                      url={author.avatarUrl}
                      size="sm"
                      className="rounded-full"
                    />
                    <span>{t('createdBy', { name: author.name })}</span>
                  </div>
                  {isBuiltIn(c) ? (
                    <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                      <Check className="size-3.5 text-success" />
                      {t('builtInProvided')}
                    </span>
                  ) : (
                    canAdopt &&
                    c.spec.type !== 'environment' &&
                    (adopted.has(capKey(c)) ? (
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
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing !== null && (
        <CapabilityEditorDialog
          capability={editing === 'new' ? null : editing}
          myWorkspaces={myWorkspaces}
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

// 발행/편집 다이얼로그. 새 capability 면 id + 타입 선택 + 공개범위 선택; 편집이면 콘텐츠만(reach 는 ⋯ → reach 변경).
function CapabilityEditorDialog({
  capability,
  myWorkspaces,
  ownerId,
  canPublishPublic,
  onClose,
}: {
  capability: Capability | null
  myWorkspaces: { id: string; name: string }[]
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
  const [url, setUrl] = useState(mcp?.url ?? '')
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
      return {
        type: 'mcp',
        url: url.trim(),
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
      return {
        type: 'code',
        language,
        code: source,
        parametersSchema,
        isReadOnly,
        requiredSecrets: cleanSecrets,
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
    return { type: 'skill', instructions }
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
          <Label htmlFor="cap-desc">{t('description')}</Label>
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
                    ? t(validateResult.existingVersions.length === 0 ? 'validateNew' : 'validateNewVersion', {
                        version: validateResult.version,
                      })
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

// reach(공개범위) 변경 다이얼로그 — 전 라이브 버전 관통. public 은 admin 만.
function ReachDialog({
  capability,
  canPublishPublic,
  myWorkspaces,
  onClose,
}: {
  capability: Capability
  canPublishPublic: boolean
  myWorkspaces: { id: string; name: string }[]
  onClose: () => void
}) {
  const t = useTranslations('capabilityStore')
  const [visibility, setVisibility] = useState<CapabilityVisibility>(capability.visibility)
  const [sharedWith, setSharedWith] = useState<string[]>(capability.sharedWith)
  const [pending, startTransition] = useTransition()

  const apply = () =>
    startTransition(async () => {
      const r = await setCapabilityVisibilityAction(capability.id, {
        visibility,
        sharedWith: visibility === 'subset' ? sharedWith : [],
      })
      if (r.ok) {
        toast.success(t('reachSaved', { name: capability.name }))
        onClose()
      } else {
        toast.error(r.error ?? t('saveError'))
      }
    })

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <h3 className="text-sm font-medium">{t('changeReach')}</h3>
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
          <div className="space-y-1">
            <Label>{t('sharedWith')}</Label>
            <p className="text-[12px] text-muted-foreground">{t('sharedWithHint')}</p>
            <WorkspacePicker
              workspaces={myWorkspaces}
              ownerId={capability.tenant}
              value={sharedWith}
              onChange={setSharedWith}
              emptyHint={t('sharedWithEmpty')}
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            onClick={apply}
            disabled={pending || (visibility === 'public' && !canPublishPublic)}
          >
            {pending ? t('saving') : t('save')}
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

// subset 대상 피커 — 내가 속한 워크스페이스들(소유 워크스페이스 제외, 그건 항상 읽음) 중 공유할 것을 다중 선택.
function WorkspacePicker({
  workspaces,
  ownerId,
  value,
  onChange,
  emptyHint,
}: {
  workspaces: { id: string; name: string }[]
  ownerId: string
  value: string[]
  onChange: (v: string[]) => void
  emptyHint: string
}) {
  const options = workspaces.filter((w) => w.id !== ownerId)
  if (options.length === 0) return <p className="text-[12px] text-muted-foreground">{emptyHint}</p>
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((w) => {
        const on = value.includes(w.id)
        return (
          <button
            key={w.id}
            type="button"
            onClick={() => toggle(w.id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset transition-colors',
              on
                ? 'bg-primary/10 text-primary ring-primary/30'
                : 'text-muted-foreground ring-border hover:bg-accent'
            )}
          >
            {w.name}
          </button>
        )
      })}
    </div>
  )
}

function VisibilityPicker({
  value,
  onChange,
  t,
  disablePublic,
}: {
  value: CapabilityVisibility
  onChange: (v: CapabilityVisibility) => void
  t: (key: string) => string
  disablePublic?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {(['private', 'workspace', 'subset', 'public'] as const).map((k) => (
        <button
          key={k}
          type="button"
          disabled={k === 'public' && disablePublic}
          onClick={() => onChange(k)}
          className={cn(
            'rounded-md px-3 py-1.5 text-[13px] font-medium ring-1 ring-inset transition-colors disabled:opacity-50',
            value === k
              ? 'bg-primary/10 text-primary ring-primary/30'
              : 'text-muted-foreground ring-border hover:bg-accent'
          )}
        >
          {t(`vis_${k}`)}
        </button>
      ))}
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
