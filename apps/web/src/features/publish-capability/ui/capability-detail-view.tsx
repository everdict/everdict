'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, CircleCheck, GitCompare, History, Loader2, Plus, Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { VersionTagsEditor } from '@/features/version-tags'
import {
  isBuiltInCapability,
  type Capability,
  type CapabilitySpecDiff,
  type CapabilityVersions,
} from '@/entities/capability'
import type { AdoptedEnvironment } from '@/entities/environment-adoption'
import { fmtDateTime } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'
import { SkillDocs } from '@/shared/ui/skill-docs'

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
import { importSkillAction } from '../api/import-skill'
import {
  IMG_CLASS_TONE,
  offersWrite,
  requiredSecretsOf,
  TYPE_ICON,
  VIS_ICON,
  type RequiredSecret,
  type StoreVariant,
} from '../lib/capability-display'
import { CodeTryPanel } from './code-try-panel'

// 스토어 상세 — 목록 행에서 드릴인한 한 capability 의 전부(메타 · 버전 라인 · 스펙 본문 · 워크스페이스 추가/제거).
// 상세는 언제나 라우트이지 다이얼로그가 아니다: 오른쪽 인프라/대화 패널에서 이 항목을 두고 실험·편집해야 하는데
// 화면 절반을 덮는 모달이면 그 흐름이 성립하지 않고, 주소로 공유할 수도 없다.
//
// 목록 행은 읽기 전용이고, **워크스페이스에 넣고 빼는 일은 여기서만** 한다 — 환경(인벤토리)·스킬(라이브러리 사본)·
// 도구(에이전트 채택)는 저장되는 곳도 권한 축도 다르지만 사용자에게는 같은 한 가지 동작이라 문구는 하나다.
export function CapabilityDetailView({
  capability,
  variant,
  author,
  currentWorkspace,
  currentSubject,
  isAdmin,
  inWorkspace,
  adoptedEnv,
  canAdopt,
  canImportEnvironment,
  canImportSkill,
  secretNames,
}: {
  capability: Capability
  variant: StoreVariant
  author: { name: string; avatarUrl?: string }
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  inWorkspace: boolean
  // 이 환경이 워크스페이스 인벤토리에 있을 때의 항목 — pull 검증 상태(재검증 버튼)를 위해.
  adoptedEnv?: AdoptedEnvironment
  canAdopt: boolean
  canImportEnvironment: boolean
  canImportSkill: boolean
  secretNames: string[]
}) {
  const t = useTranslations('capabilityStore')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // 필요 시크릿/쓰기 옵션이 있을 때만 뜨는 바인딩 다이얼로그(없으면 바로 추가).
  const [adopting, setAdopting] = useState(false)
  // 상세에 표시할 레코드 — 최신(라우트가 실어 온 것) 또는 버전 스위처로 고른 과거 버전.
  const [shown, setShown] = useState<Capability>(capability)
  useEffect(() => setShown(capability), [capability])

  const TypeIcon = TYPE_ICON[capability.spec.type]
  const VisIcon = VIS_ICON[capability.visibility]
  const managed = isBuiltInCapability(capability)
  const isEnv = capability.spec.type === 'environment'
  const isSkill = capability.spec.type === 'skill'
  // 환경은 워크스페이스 인벤토리(settings:write), 스킬은 스킬 라이브러리(skills:write), 그 외는 내 에이전트
  // (agents:write) — 저장되는 곳도 권한도 다르지만 사용자에게는 같은 한 가지 동작이라 문구는 하나다.
  const canChange = isEnv ? canImportEnvironment : isSkill ? canImportSkill : canAdopt
  // 스킬은 여기서 뺄 수 없다: 가져온 것은 참조가 아니라 우리 워크스페이스 스킬 사본이라, 지우는 일은
  // Settings › Agent › Skills 에서 그 스킬을 지우는 일이다(스토어가 남의 편집물을 회수할 수는 없다).
  const canRemoveHere = canChange && !isSkill
  // 우리가 발행한 스킬을 우리가 다시 가져오는 것은 같은 이름의 사본을 하나 더 만드는 일일 뿐이다 — 원본 Skill 은
  // 이미 라이브러리에 있다(발행은 남들에게 복사거리를 내주는 행위이지, 내 라이브러리에 뭔가를 더하는 게 아니다).
  const ownPublication = isSkill && capability.tenant === currentWorkspace
  const verify = adoptedEnv?.verify

  // 추가/제거는 서버 액션이 관련 목록을 revalidate 하고, 이 페이지는 라우터 새로고침으로 자기 상태(있음/없음)를 다시 읽는다.
  const startAdopt = () => {
    if (requiredSecretsOf(capability).length > 0 || offersWrite(capability)) setAdopting(true)
    else adopt({}, false)
  }
  const adopt = (secretBindings: Record<string, string>, enableWrite: boolean) =>
    startTransition(async () => {
      const r = await adoptCapabilityAction({
        source: capability.tenant,
        id: capability.id,
        version: capability.version,
        secretBindings,
        enableWrite,
      })
      if (r.ok) {
        toast.success(t('added', { name: capability.name }))
        router.refresh()
      } else {
        toast.error(r.error ?? t('addError'))
      }
      setAdopting(false)
    })
  const unadopt = () =>
    startTransition(async () => {
      const r = await unadoptCapabilityAction(capability.tenant, capability.id)
      if (r.ok) {
        toast.success(t('removedFromWorkspace', { name: capability.name }))
        router.refresh()
      } else toast.error(r.error ?? t('addError'))
    })

  // 스킬 추가 — 참조를 pin 하는 게 아니라 **사본**을 만든다. 그 순간부터 Settings › Agent › Skills 의 워크스페이스
  // 스킬이고, 편집도 버전 찍기도 거기서 한다(everdict 매니지드 스킬이 워크스페이스에 들어오는 유일한 경로).
  const importSkill = () =>
    startTransition(async () => {
      const r = await importSkillAction({
        source: capability.tenant,
        id: capability.id,
        version: capability.version,
      })
      if (r.ok) {
        toast.success(t('skillCopied', { name: capability.name }))
        router.refresh()
      } else toast.error(r.error ?? t('addError'))
    })

  // environment 추가/제거 — 워크스페이스 인벤토리에 넣고, 넣을 때 pull 가능성을 검증한다(warn-not-block).
  const importEnv = () =>
    startTransition(async () => {
      const r = await adoptEnvironmentAction({
        source: capability.tenant,
        id: capability.id,
        version: capability.version,
      })
      if (!r.ok) {
        toast.error(r.error ?? t('importError'))
        return
      }
      if (r.environment.verify?.pullable === false)
        toast.warning(t('importedNotPullable', { name: capability.name }))
      else toast.success(t('imported', { name: capability.name }))
      router.refresh()
    })
  const removeEnv = () =>
    startTransition(async () => {
      const r = await unadoptEnvironmentAction(capability.tenant, capability.id)
      if (!r.ok) toast.error(r.error ?? t('unimportError'))
      else {
        toast.success(t('unimported', { name: capability.name }))
        router.refresh()
      }
    })
  const reverifyEnv = (e: AdoptedEnvironment) =>
    startTransition(async () => {
      const r = await verifyAdoptedEnvironmentAction(e.source, e.id)
      if (!r.ok) toast.error(r.error ?? t('reverifyError'))
      else {
        if (r.environment.verify?.pullable === false)
          toast.warning(t('importedNotPullable', { name: e.name ?? e.id }))
        else toast.success(t('reverified'))
        router.refresh()
      }
    })

  return (
    <div className="space-y-6">
      {/* 메타 스트립 — 종류 · 매니지드 · 공개범위(내 발행) · 버전 · 작성자. 결정(추가/제거)은 오른쪽. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          <Badge tone="outline" className="gap-1">
            <TypeIcon className="size-3" />
            {t(`type_${capability.spec.type}`)}
          </Badge>
          {managed && (
            <Badge tone="info" className="gap-1">
              <Sparkles className="size-3" />
              {t('managed')}
            </Badge>
          )}
          {variant === 'mine' && (
            <Badge
              tone={capability.visibility === 'private' ? 'outline' : 'info'}
              className="gap-1"
            >
              <VisIcon className="size-3" />
              {t(`vis_${capability.visibility}`)}
            </Badge>
          )}
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
            {capability.version}
          </code>
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={author.name} url={author.avatarUrl} size="sm" className="rounded-full" />
            {t('createdBy', { name: author.name })}
          </span>
          <span>{fmtDateTime(capability.createdAt)}</span>
          {capability.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] ring-1 ring-inset ring-border"
            >
              #{tag}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {inWorkspace ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-success">
              <CircleCheck className="size-4" />
              {isSkill ? t('detailSkillCopied') : t('detailInWorkspace')}
            </span>
          ) : ownPublication ? (
            <span className="text-[12px] text-muted-foreground">{t('skillOwnPublication')}</span>
          ) : isSkill ? (
            // 스킬만 결과가 다르다 — 참조가 붙는 게 아니라 우리가 고칠 수 있는 사본이 생긴다. InfoTip 이 아니라
            // 버튼 옆 한 줄로 두는 이유: 누르기 전에 알아야 하는 사실이다.
            <span className="text-[12px] text-muted-foreground">{t('skillCopyHint')}</span>
          ) : null}
          {inWorkspace
            ? canRemoveHere && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={isEnv ? removeEnv : unadopt}
                >
                  {t('removeFromWorkspace')}
                </Button>
              )
            : canChange &&
              !ownPublication && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={isEnv ? importEnv : isSkill ? importSkill : startAdopt}
                >
                  <Plus />
                  {t('addToWorkspace')}
                </Button>
              )}
        </div>
      </div>

      {managed && <p className="text-[12.5px] text-muted-foreground">{t('managedHint')}</p>}

      {/* 인벤토리에 있는 환경의 pull 상태 — 못 끌어오는 이유까지 그대로, 그 자리에서 다시 검증. */}
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
              onClick={() => reverifyEnv(adoptedEnv)}
            >
              {t('reverify')}
            </button>
          )}
        </div>
      )}

      <CapabilitySpecPanel
        capability={capability}
        shown={shown}
        currentWorkspace={currentWorkspace}
        currentSubject={currentSubject}
        isAdmin={isAdmin}
        onShowVersion={setShown}
      />

      {adopting && (
        <AdoptDialog
          capability={capability}
          secretNames={secretNames}
          pending={pending}
          onClose={() => setAdopting(false)}
          onAdopt={adopt}
        />
      )}
    </div>
  )
}

// 스펙 본문 — 버전 패널(목록·스위처·태그·diff) + 종류별 전체 스펙(mcp/code/skill/environment)을 읽기 전용으로.
function CapabilitySpecPanel({
  capability,
  shown,
  currentWorkspace,
  currentSubject,
  isAdmin,
  onShowVersion,
}: {
  capability: Capability
  shown: Capability
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  onShowVersion: (record: Capability) => void
}) {
  const t = useTranslations('capabilityStore')
  // 크로스테넌트 public/subset 은 오너 워크스페이스를 source 로 넘겨 버전을 조회한다. 내 워크스페이스 것이면 생략.
  const source = capability.tenant !== currentWorkspace ? capability.tenant : undefined
  const builtin = isBuiltInCapability(capability)
  // 버전 태그 편집 = 내 워크스페이스 소유 + 버전 생성자-or-admin(서버가 최종 강제). 빌트인/크로스테넌트는 읽기전용.
  const canManageVersions =
    !builtin && source === undefined && (capability.createdBy === currentSubject || isAdmin)
  const s = shown.spec
  const secrets = s.type === 'mcp' || s.type === 'code' ? s.requiredSecrets : []
  return (
    <div className="space-y-3 rounded-md border border-border bg-secondary/30 p-3 text-[12.5px]">
      {!builtin && (
        <CapabilityVersionsPanel
          id={capability.id}
          source={source}
          latestVersion={capability.version}
          shownVersion={shown.version}
          canManage={canManageVersions}
          onShowVersion={onShowVersion}
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
        // 멀티문서 스킬 뷰어(SKILL.md + 부속 파일 탭) — 스킬 관리 상세와 동일한 공용 뷰어를 공유.
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

// 버전 관리 패널(레지스트리 엔티티 패리티) — 버전 목록·스위처·버전 태그·구조 diff. 상세가 라우트가 되어도 버전 목록은
// 페이지 props 가 아니라 온디맨드로 읽는다(스위처가 고르는 순간에만 필요한 데이터). 내 워크스페이스 소유 + 생성자/admin
// 이면 태그 편집(canManage), 아니면 읽기전용. source=크로스테넌트 public/subset 오너(내 것이면 생략).
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

// 추가 다이얼로그 — 필요 시크릿을 내 워크스페이스 시크릿 이름으로 바인딩 + 쓰기 옵트인. 그 다음 에이전트에 pin 추가.
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
  const required: RequiredSecret[] = requiredSecretsOf(capability)
  const write = offersWrite(capability)
  const [bindings, setBindings] = useState<Record<string, string>>(
    Object.fromEntries(required.map((s) => [s.name, s.name]))
  )
  const [enableWrite, setEnableWrite] = useState(false)

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-4 p-5">
        <div>
          <h3 className="text-sm font-medium">{t('addTitle', { name: capability.name })}</h3>
          {capability.spec.type === 'code' && (
            <p className="mt-1 text-[12px] text-muted-foreground">{t('addCodeNote')}</p>
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
            {pending ? t('saving') : t('addToWorkspace')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
