'use client'

import { useState, useTransition } from 'react'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { ModelSpec } from '@/entities/model'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { createModelAction, validateModelAction } from '../api/manage-models'

// 한 모델 id 의 최신 스펙 + 소유/버전 (설정 카드 표시용). spec 은 상세 페치 실패 시 없을 수 있다.
export interface ModelEntry {
  id: string
  owner: string
  versions: string[]
  spec?: ModelSpec
}

// 워크스페이스 모델 관리 카드 — 지원 LLM 모델을 raw env 조합이 아니라 일급 엔티티로 등록/조회.
// 각 모델은 provider·모델식별자·baseUrl 과, 에이전트 서버/저지가 쓸 때 연결할 API 키 시크릿(apiKeySecret) 이름을 갖는다.
export function ModelsManager({
  models,
  secretNames,
  canWrite,
}: {
  models: ModelEntry[]
  secretNames: string[]
  canWrite: boolean
}) {
  const t = useTranslations('manageModels')
  const [adding, setAdding] = useState(false)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('title')}</h2>
          <InfoTip content={t('help')} />
        </div>
        {canWrite && !adding && (
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

      {canWrite && adding && (
        <AddModelForm
          secretNames={secretNames}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {models.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-[13px] text-muted-foreground">
          {t('empty')}
          {canWrite && ` ${t('emptyHint')}`}
        </p>
      ) : (
        <SettingsList>
          {models.map((m) => (
            <SettingsRow
              key={m.id}
              label={
                <span className="flex items-center gap-2">
                  <code className="font-mono text-[13px] text-foreground">{m.id}</code>
                  {m.owner === '_shared' && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t('shared')}
                    </span>
                  )}
                </span>
              }
              hint={<ModelHint entry={m} secretNames={secretNames} />}
            >
              <span className="text-[12px] text-faint">
                {t('versions', { count: m.versions.length })}
              </span>
            </SettingsRow>
          ))}
        </SettingsList>
      )}
    </div>
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

// 인라인 등록 폼 — provider · id · version · 모델식별자 · baseUrl · apiKeySecret(SecretPicker) · 설명. validate → create.
function AddModelForm({
  secretNames,
  onDone,
  onCancel,
}: {
  secretNames: string[]
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('manageModels')
  const [provider, setProvider] = useState('openai')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeySecret, setApiKeySecret] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function submit() {
    setError(undefined)
    const spec = {
      id: id.trim(),
      version: version.trim(),
      provider,
      model: model.trim(),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKeySecret.trim() ? { apiKeySecret: apiKeySecret.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    }
    startTransition(async () => {
      const v = await validateModelAction(spec)
      if (!v.ok) {
        setError(v.errors && v.errors.length > 0 ? v.errors.join('; ') : (v.error ?? t('invalid')))
        return
      }
      if (v.versionExists) {
        setError(t('versionExists', { version: spec.version }))
        return
      }
      const c = await createModelAction(spec)
      if (!c.ok) {
        setError(c.error ?? t('invalid'))
        return
      }
      onDone()
    })
  }

  const ready = id.trim() !== '' && version.trim() !== '' && model.trim() !== ''

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('formProvider')}>
          <Combobox
            value={provider}
            onChange={setProvider}
            options={[{ value: 'openai' }, { value: 'anthropic' }]}
            aria-label={t('formProvider')}
          />
        </Field>
        <Field label={t('formId')}>
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="gpt-5.4-mini" />
        </Field>
        <Field label={t('formModel')} hint={t('formModelHint')}>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5.4-mini"
          />
        </Field>
        <Field label={t('formVersion')}>
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
        </Field>
        <Field label={t('formBaseUrl')} hint={t('formBaseUrlHint')}>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://litellm.internal/v1"
          />
        </Field>
        <Field label={t('formApiKey')} hint={t('formApiKeyHint')}>
          <SecretPicker
            value={apiKeySecret}
            onChange={setApiKeySecret}
            names={secretNames}
            scope="workspace"
            aria-label={t('formApiKey')}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('formDescription')}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!ready || pending} onClick={submit}>
          {pending ? t('saving') : t('save')}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
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
