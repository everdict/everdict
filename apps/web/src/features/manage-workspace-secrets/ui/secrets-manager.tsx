'use client'

import { useState, useTransition } from 'react'
import { Eye, EyeOff, KeyRound, Plus } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import {
  PROVIDER_TOKENS,
  providerTokenNames,
  type ProviderTokenDef,
  type SecretMeta,
  type SecretScope,
} from '@/entities/secret'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { FieldError, Input, Label, Textarea } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { deleteSecretAction, setSecretAction } from '../api/manage-secrets'

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

// workspace = 워크스페이스(공유) 시크릿 — 저장소가 카테고리 없는 단일 평면 네임스페이스라 UI 도 한 목록
// (모델 키·클러스터 자격증명을 나누면 같은 시크릿이 양쪽에 중복 노출된다). personal = 내 개인 시크릿(계정 화면, 셀프 관리).
// namePlaceholder 는 예약 이름 예시(번역 대상 아님) — 나머지 카피는 next-intl 메시지로.
const COPY = {
  workspace: { namePlaceholder: 'OPENAI_API_KEY' },
  personal: { namePlaceholder: 'MY_OPENAI_API_KEY' },
} as const

export function SecretsManager({
  variant,
  secrets,
  canWrite,
}: {
  variant: 'workspace' | 'personal'
  secrets: SecretMeta[]
  canWrite: boolean
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const copy = COPY[variant]
  // personal = 개인(user) 스코프(셀프 관리), workspace = 공유(admin).
  const scope: SecretScope = variant === 'personal' ? 'user' : 'workspace'
  // 프로바이더 토큰(예약 이름, 플랫폼이 소비) — 스코프에서 소비되는 것만 큐레이션.
  const providers = PROVIDER_TOKENS.filter((pt) => pt.scopes.includes(scope))
  // raw 목록에선 프로바이더 토큰을 제외(이중 노출 방지 — 위 큐레이션 섹션이 그 자리).
  const rawSecrets = secrets.filter((s) => !(providerTokenNames.has(s.name) && s.scope === scope))

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
            {t(`${variant}.title`)}
            <InfoTip
              content={
                <>
                  {t(`${variant}.help`)}
                  <br />
                  {t('encryptedNote')}
                </>
              }
            />
          </h3>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t(`${variant}.desc`)}
          </p>
        </div>
      </div>

      {providers.length > 0 && (
        <ProviderTokenRows
          providers={providers}
          secrets={secrets}
          scope={scope}
          canWrite={canWrite}
        />
      )}

      <SecretRows
        secrets={rawSecrets}
        canWrite={canWrite}
        scope={scope}
        namePlaceholder={copy.namePlaceholder}
        {...(providers.length > 0 ? { sectionLabel: t('customSecretsLabel') } : {})}
      />

      {!canWrite && <p className="text-[12.5px] text-muted-foreground">{t('adminRequired')}</p>}
    </div>
  )
}

// 프로바이더 토큰 — 예약 이름이 미리 정해진 큐레이션 목록. 유저는 이름을 몰라도 "어떤 서비스 토큰인지"로 등록한다.
function ProviderTokenRows({
  providers,
  secrets,
  scope,
  canWrite,
}: {
  providers: ProviderTokenDef[]
  secrets: SecretMeta[]
  scope: SecretScope
  canWrite: boolean
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const locale = useLocale()
  const [editing, setEditing] = useState<string>() // 등록/교체 폼이 열린 토큰 name
  const [confirmName, setConfirmName] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onDelete(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteSecretAction(target, scope)
      setConfirmName(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-2.5">
      <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
        {t('providerTokensLabel')}
      </span>
      <SettingsList>
        {providers.map((pt) => {
          const registered = secrets.find((s) => s.name === pt.name && s.scope === scope)
          return (
            <SettingsRow
              key={pt.name}
              label={
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] font-[560] text-foreground">
                    {t(`providerTokens.${pt.name}.provider`)}
                  </span>
                  <InfoTip
                    content={
                      <>
                        {t(`providerTokens.${pt.name}.help`)}
                        <br />
                        {t.rich('savedAsName', {
                          name: pt.name,
                          code: (chunks) => <code className="font-mono">{chunks}</code>,
                        })}
                      </>
                    }
                  />
                </span>
              }
              hint={
                registered
                  ? t('registeredHint', {
                      usedFor: t(`providerTokens.${pt.name}.usedFor`),
                      date: new Date(registered.updatedAt).toLocaleDateString(locale),
                    })
                  : t(`providerTokens.${pt.name}.usedFor`)
              }
            >
              {canWrite && (
                <span className="flex items-center gap-2.5">
                  {registered ? (
                    confirmName === pt.name ? (
                      <>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={pending}
                          onClick={() => onDelete(pt.name)}
                        >
                          {t('deleteConfirm')}
                        </Button>
                        <button
                          type="button"
                          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setConfirmName(undefined)}
                        >
                          {t('cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setEditing(editing === pt.name ? undefined : pt.name)}
                        >
                          {t('replace')}
                        </button>
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-destructive"
                          onClick={() => setConfirmName(pt.name)}
                        >
                          {t('delete')}
                        </button>
                      </>
                    )
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditing(editing === pt.name ? undefined : pt.name)}
                    >
                      {t('register')}
                    </Button>
                  )}
                  <a
                    href={pt.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                  >
                    {t('issue')}
                  </a>
                </span>
              )}
            </SettingsRow>
          )
        })}
      </SettingsList>
      {editing && (
        <AddSecretForm
          scope={scope}
          namePlaceholder=""
          fixedName={editing}
          onDone={() => setEditing(undefined)}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// 리스트(구분선 카드) + 상단 우측 "시크릿 추가" → 토글 인라인 폼. Linear settings-list 스타일.
function SecretRows({
  secrets,
  canWrite,
  scope,
  namePlaceholder,
  sectionLabel,
}: {
  secrets: SecretMeta[]
  canWrite: boolean
  scope: SecretScope
  namePlaceholder: string
  sectionLabel?: string // 프로바이더 토큰 섹션과 병렬일 때 구분 라벨
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const locale = useLocale()
  const [adding, setAdding] = useState(false)
  const [confirmName, setConfirmName] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onDelete(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteSecretAction(target, scope)
      setConfirmName(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-[510] text-faint">
          {sectionLabel ? (
            <span className="text-[11px] uppercase tracking-wide">{sectionLabel}</span>
          ) : secrets.length > 0 ? (
            t('registeredCount', { count: secrets.length })
          ) : (
            ''
          )}
        </span>
        {canWrite && !adding && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-1"
            onClick={() => {
              setAdding(true)
              setError(undefined)
            }}
          >
            <Plus className="size-3.5" /> {t('addSecret')}
          </Button>
        )}
      </div>

      {canWrite && adding && (
        <AddSecretForm
          scope={scope}
          namePlaceholder={namePlaceholder}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {secrets.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-[13px] text-muted-foreground">
          {t('emptyTitle')}
          {canWrite && t('emptyHint')}
        </p>
      ) : (
        <SettingsList>
          {secrets.map((s) => (
            <SettingsRow
              key={s.name}
              label={<code className="font-mono text-[13px] text-foreground">{s.name}</code>}
              hint={t('updatedHint', { date: new Date(s.updatedAt).toLocaleString(locale) })}
            >
              {canWrite &&
                (confirmName === s.name ? (
                  <span className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => onDelete(s.name)}
                    >
                      {t('deleteConfirm')}
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setConfirmName(undefined)}
                    >
                      {t('cancel')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => setConfirmName(s.name)}
                  >
                    {t('delete')}
                  </button>
                ))}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// 토글되는 인라인 추가 폼 — 이름 + 값(한 줄 ↔ 여러 줄 전환, 한 줄은 보기 토글) + 저장/취소. 카드 안에 컴팩트하게.
// fixedName = 프로바이더 토큰(예약 이름): 이름 입력을 숨기고 값만(한 줄) 받는다.
function AddSecretForm({
  scope,
  namePlaceholder,
  fixedName,
  onDone,
  onCancel,
}: {
  scope: SecretScope
  namePlaceholder: string
  fixedName?: string
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('manageWorkspaceSecrets')
  const [name, setName] = useState(fixedName ?? '')
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [multiline, setMultiline] = useState(false) // kubeconfig 같은 여러 줄 값 입력 전환
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()
  const nameInvalid = name.length > 0 && !NAME_RE.test(name)

  function onSave() {
    setError(undefined)
    startTransition(async () => {
      const r = await setSecretAction(name, value, scope)
      if (r.ok) onDone()
      else setError(r.error)
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3.5">
      <div className={fixedName ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'}>
        {!fixedName && (
          <div className="space-y-1.5">
            <Label htmlFor="secret-name">{t('nameLabel')}</Label>
            <Input
              id="secret-name"
              value={name}
              placeholder={namePlaceholder}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-[12px]"
            />
            {nameInvalid && <FieldError message={t('nameInvalid')} />}
          </div>
        )}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="secret-value">{t('valueLabel')}</Label>
            {!fixedName && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setMultiline((v) => !v)}
              >
                {multiline ? t('singleLine') : t('multiLine')}
              </button>
            )}
          </div>
          {multiline ? (
            <Textarea
              id="secret-value"
              value={value}
              placeholder={t('multilinePlaceholder')}
              onChange={(e) => setValue(e.target.value)}
              rows={4}
              spellCheck={false}
              className="text-[12px]"
            />
          ) : (
            <div className="relative">
              <Input
                id="secret-value"
                type={show ? 'text' : 'password'}
                value={value}
                placeholder={t('valuePlaceholder')}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="pr-8 text-[12px]"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? t('hideValue') : t('showValue')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          )}
        </div>
      </div>
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="gap-1"
          disabled={pending || name.length === 0 || value.length === 0 || nameInvalid}
          onClick={onSave}
        >
          <KeyRound className="size-3.5" /> {pending ? t('saving') : t('save')}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
        <span className="text-[11px] text-faint">{t('saveNote')}</span>
      </div>
    </div>
  )
}
