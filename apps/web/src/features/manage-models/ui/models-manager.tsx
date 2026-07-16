'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { CheckCircle2, Loader2, Pencil, Plug, Plus, Trash2, TriangleAlert, X, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { ModelSpec } from '@/entities/model'
import { SecretPicker } from '@/features/pick-secret'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip, Tooltip } from '@/shared/ui/tooltip'

import { deleteModelAction, saveModelAction, testModelConnectionAction } from '../api/manage-models'

// 한 모델 id 의 최신 스펙 + 소유/버전 (설정 카드 표시용). spec 은 상세 페치 실패 시 없을 수 있다.
// createdBy = 최초 등록 버전의 등록자(seed/_shared 는 없음) — 삭제 버튼 노출(등록자-or-admin) 판단용.
export interface ModelEntry {
  id: string
  owner: string
  versions: string[]
  createdBy?: string
  spec?: ModelSpec
}

// 워크스페이스 모델 관리 카드 — 지원 LLM 모델을 raw env 조합이 아니라 일급 엔티티로 등록/편집/조회.
// 버전은 UI 에서 감춘다(내부 불변 버전은 유지) — 등록/편집은 연결 테스트 통과 후에만 저장된다.
// canDelete = 이 워크스페이스의 admin(models:delete). currentSubject = 로그인 subject — admin 이 아니어도 자기가 등록한 모델은 삭제 가능.
export function ModelsManager({
  models,
  secretNames,
  canWrite,
  canDelete,
  currentSubject,
}: {
  models: ModelEntry[]
  secretNames: string[]
  canWrite: boolean
  canDelete: boolean
  currentSubject?: string
}) {
  const t = useTranslations('manageModels')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ModelEntry | null>(null)
  const formOpen = adding || editing !== null

  function closeForm() {
    setAdding(false)
    setEditing(null)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('title')}</h2>
          <InfoTip content={t('help')} />
        </div>
        {canWrite && !formOpen && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-1"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" /> {t('addModel')}
          </Button>
        )}
      </div>

      {canWrite && formOpen && (
        <ModelForm
          mode={editing ? 'edit' : 'add'}
          secretNames={secretNames}
          {...(editing ? { initialId: editing.id } : {})}
          {...(editing?.spec ? { initial: editing.spec } : {})}
          onDone={closeForm}
          onCancel={closeForm}
        />
      )}

      {models.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-[13px] text-muted-foreground">
          {t('empty')}
          {canWrite && ` ${t('emptyHint')}`}
        </p>
      ) : (
        <SettingsList>
          {models.map((m) => {
            const owned = m.owner !== '_shared'
            return (
              <SettingsRow
                key={m.id}
                label={
                  <span className="flex items-center gap-2">
                    <code className="font-mono text-[13px] text-foreground">{m.id}</code>
                    {!owned && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t('shared')}
                      </span>
                    )}
                  </span>
                }
                hint={<ModelHint entry={m} secretNames={secretNames} />}
              >
                <span className="flex items-center gap-1">
                  {/* 실제 커넥션 확인 — 더미콜을 날려 응답이 오면 ✓, 아니면 ✗ (스펙을 아는 행만). */}
                  {m.spec && <RowConnectionCheck id={m.id} spec={m.spec} />}
                  {/* 편집(새 불변 버전으로 저장) — 워크스페이스 소유 + 쓰기 권한 + 스펙을 아는 행만. */}
                  {owned && canWrite && m.spec && (
                    <button
                      type="button"
                      onClick={() => {
                        setAdding(false)
                        setEditing(m)
                      }}
                      aria-label={t('editModel', { id: m.id })}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  {/* 삭제는 워크스페이스 소유 모델만(_shared 는 불가) + admin 또는 등록자 본인일 때만 노출. 최종 강제는 컨트롤플레인. */}
                  {owned &&
                    (canDelete || (currentSubject !== undefined && m.createdBy === currentSubject)) && (
                      <DeleteModelControl id={m.id} />
                    )}
                </span>
              </SettingsRow>
            )
          })}
        </SettingsList>
      )}
    </div>
  )
}

// 행별 커넥션 체크 버튼 — idle(플러그) → 진행(스피너) → ✓/✗. 결과(응답/에러)는 툴팁으로. 다시 눌러 재확인.
function RowConnectionCheck({ id, spec }: { id: string; spec: ModelSpec }) {
  const t = useTranslations('manageModels')
  const [result, setResult] = useState<{ ok: boolean; message?: string }>()
  const [checking, startCheck] = useTransition()

  function run() {
    if (checking) return
    startCheck(async () => {
      const r = await testModelConnectionAction(connectionOf(spec))
      setResult(r.ok ? { ok: true, message: r.text } : { ok: false, message: r.error })
    })
  }

  const icon = checking ? (
    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  ) : result?.ok === true ? (
    <CheckCircle2 className="size-3.5 text-emerald-500" />
  ) : result?.ok === false ? (
    <XCircle className="size-3.5 text-destructive" />
  ) : (
    <Plug className="size-3.5 text-faint" />
  )

  const tip =
    result?.ok === true
      ? t('checkOk', { text: result.message ?? '' })
      : result?.ok === false
        ? t('checkFailed', { error: result.message ?? '' })
        : t('checkHint')

  return (
    <Tooltip content={tip}>
      <button
        type="button"
        onClick={run}
        disabled={checking}
        aria-label={t('checkConnection', { id })}
        className="grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent disabled:cursor-default"
      >
        {icon}
      </button>
    </Tooltip>
  )
}

// 행별 삭제 트리거(휴지통 아이콘) + 확인 다이얼로그. 모델 전체(모든 소유 버전)를 소프트-딜리트한다.
function DeleteModelControl({ id }: { id: string }) {
  const t = useTranslations('manageModels')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('deleteModel', { id })}
        className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
      {open && <DeleteModelDialog id={id} onClose={() => setOpen(false)} />}
    </>
  )
}

// 모델 삭제 확인 다이얼로그 — 툼스톤(과거 스코어카드는 재현 보존, 이후 참조 실행은 해석 실패). 컨트롤플레인이 등록자-or-admin 을 강제.
function DeleteModelDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('manageModels')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const titleId = `delete-model-${id}`

  function onConfirm() {
    if (pending) return
    setError(undefined)
    startTransition(async () => {
      const res = await deleteModelAction(id)
      if (!res.ok) {
        setError(res.error ?? t('deleteFailed'))
        return
      }
      toast.success(t('deletedModel', { id }))
      onClose()
      router.refresh()
    })
  }

  return (
    <Dialog open onClose={onClose} className="max-w-md" labelledBy={titleId}>
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20">
          <TriangleAlert className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">
            {t('deleteTitle')}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">{id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-3 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{t('deleteExplain')}</p>
        <Callout tone="danger" className="py-2">
          {t('deleteWarning')}
        </Callout>
        {error && (
          <Callout tone="danger" className="py-2">
            {error}
          </Callout>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {t('deleteConfirm')}
        </Button>
      </div>
    </Dialog>
  )
}

// provider · 모델식별자 · baseUrl + API 키 연결 상태(연결한 시크릿 이름 / provider 기본 / 미설정 경고).
function ModelHint({ entry, secretNames }: { entry: ModelEntry; secretNames: string[] }) {
  const t = useTranslations('manageModels')
  const spec = entry.spec
  if (!spec) return <>{t('detailUnavailable')}</>
  const keyName = spec.apiKeySecret
  const keyMissing = keyName !== undefined && !secretNames.includes(keyName)
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="text-foreground/80">
        {spec.provider} · {spec.model}
      </span>
      {spec.baseUrl && <span className="text-faint">{spec.baseUrl}</span>}
      {keyName ? (
        <span className={keyMissing ? 'text-destructive' : 'text-faint'}>
          {t('keyLinked', { name: keyName })}
          {keyMissing && ` — ${t('keyMissing')}`}
        </span>
      ) : (
        <span className="text-faint">{t('keyDefault')}</span>
      )}
    </span>
  )
}

// spec → 커넥션 서브셋(테스트/저장에 필요한 provider·model·baseUrl·apiKeySecret 만).
function connectionOf(spec: {
  provider: string
  model: string
  baseUrl?: string
  apiKeySecret?: string
}): Record<string, string> {
  return {
    provider: spec.provider,
    model: spec.model,
    ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
    ...(spec.apiKeySecret ? { apiKeySecret: spec.apiKeySecret } : {}),
  }
}

// 등록/편집 통합 폼 — provider · id(편집 시 고정) · 모델식별자 · baseUrl · apiKeySecret(SecretPicker) · 설명.
// 버전 입력 없음(내부 자동 배정). 저장은 반드시 "연결 테스트"가 성공한 뒤에만 활성화되고, 커넥션 필드를 바꾸면 테스트가 무효화된다.
function ModelForm({
  mode,
  secretNames,
  initial,
  initialId,
  onDone,
  onCancel,
}: {
  mode: 'add' | 'edit'
  secretNames: string[]
  initial?: ModelSpec
  initialId?: string
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('manageModels')
  const router = useRouter()
  const editing = mode === 'edit'
  const [provider, setProvider] = useState<string>(initial?.provider ?? 'openai')
  const [id, setId] = useState(initialId ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKeySecret, setApiKeySecret] = useState(initial?.apiKeySecret ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [test, setTest] = useState<{ ok: boolean; text?: string; error?: string }>()
  const [testing, startTest] = useTransition()
  const [saving, startSave] = useTransition()
  const [error, setError] = useState<string>()

  // 커넥션에 영향을 주는 필드가 바뀌면 직전 테스트 결과를 무효화 — 저장되는 커넥션은 항상 테스트한 커넥션과 같아야 한다.
  function invalidateTest() {
    setTest(undefined)
  }

  const ready = id.trim() !== '' && model.trim() !== ''
  const tested = test?.ok === true

  function connection(): Record<string, string> {
    return {
      provider,
      model: model.trim(),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKeySecret.trim() ? { apiKeySecret: apiKeySecret.trim() } : {}),
    }
  }

  function onTest() {
    if (!ready || testing) return
    setError(undefined)
    startTest(async () => {
      const r = await testModelConnectionAction(connection())
      setTest(r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error })
    })
  }

  function onSave() {
    if (!tested || saving) return
    setError(undefined)
    startSave(async () => {
      const body = {
        ...connection(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }
      const r = await saveModelAction(id.trim(), body)
      if (!r.ok) {
        setError(r.error ?? t('invalid'))
        return
      }
      toast.success(editing ? t('savedEdit', { id: id.trim() }) : t('savedNew', { id: id.trim() }))
      onDone()
      router.refresh()
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-[560] text-foreground">
          {editing ? t('editTitle', { id: initialId ?? '' }) : t('addModel')}
        </h3>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('formProvider')}>
          <Combobox
            value={provider}
            onChange={(v) => {
              setProvider(v)
              invalidateTest()
            }}
            options={[{ value: 'openai' }, { value: 'anthropic' }]}
            aria-label={t('formProvider')}
          />
        </Field>
        <Field label={t('formId')}>
          <Input
            value={id}
            onChange={(e) => {
              setId(e.target.value)
              invalidateTest()
            }}
            placeholder="gpt-5.4-mini"
            disabled={editing}
          />
        </Field>
        <Field label={t('formModel')} hint={t('formModelHint')}>
          <Input
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              invalidateTest()
            }}
            placeholder="gpt-5.4-mini"
          />
        </Field>
        <Field label={t('formBaseUrl')} hint={t('formBaseUrlHint')}>
          <Input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              invalidateTest()
            }}
            placeholder="https://litellm.internal/v1"
          />
        </Field>
        <Field label={t('formApiKey')} hint={t('formApiKeyHint')}>
          <SecretPicker
            value={apiKeySecret}
            onChange={(v) => {
              setApiKeySecret(v)
              invalidateTest()
            }}
            names={secretNames}
            scope="workspace"
            aria-label={t('formApiKey')}
          />
        </Field>
        <Field label={t('formDescription')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      {/* 연결 테스트 결과 — 성공 시 응답 프리뷰, 실패 시 사유. */}
      {test?.ok === true && (
        <Callout tone="info" className="py-2">
          {t('testOk')}
          {test.text ? ` ${test.text}` : ''}
        </Callout>
      )}
      {test?.ok === false && (
        <Callout tone="warning" className="py-2">
          {t('testFailed', { error: test.error ?? '' })}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* 저장은 연결 테스트 통과 후에만 활성화(강제 — 버튼 비활성은 UX, 최종 강제는 컨트롤플레인). */}
        <Button type="button" size="sm" disabled={!tested || saving} onClick={onSave} className="gap-1.5">
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )}
          {saving ? t('saving') : editing ? t('saveEdit') : t('save')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!ready || testing}
          onClick={onTest}
          className="gap-1.5"
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
          {testing ? t('testing') : t('testConnection')}
        </Button>
        {!tested && <span className="text-[11px] text-muted-foreground">{t('testFirst')}</span>}
        <button
          type="button"
          className="ml-auto text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}
