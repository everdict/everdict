'use client'

import { useMemo, useState, useTransition } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Textarea } from '@/shared/ui/input'

import { createSecretAction } from '../api/create-secret'

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export type SecretPickerScope = 'user' | 'workspace'

// 시크릿 참조 피커 — 로드된 시크릿 이름에서 고르거나 "새로"로 인라인 생성해 그 이름을 참조로 쓴다.
// 값 원문은 폼/스펙에 남지 않는다(이름만 저장). 시크릿 이름을 받는 입력은 자유 텍스트 대신 이 피커를 쓴다
// (하니스 env·GHE App 개인키·Mattermost 토큰 …).
export function SecretPicker({
  value,
  onChange,
  names,
  scope,
  onCreated,
  hint,
  defaultMultiline,
  createValuePlaceholder,
  id,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (name: string) => void
  names: string[] // 서버 프리로드된 이 스코프의 시크릿 이름(값은 안 옴)
  scope: SecretPickerScope // 인라인 생성이 저장될 티어(개인/워크스페이스)
  onCreated?: (name: string) => void // 인라인 생성 통지 — 상위가 목록을 여러 피커에 공유할 때
  hint?: React.ReactNode // 선택된 값 아래 안내(생성 폼이 열려 있으면 숨김)
  defaultMultiline?: boolean // PEM/kubeconfig 처럼 여러 줄 값이 기본인 시크릿
  createValuePlaceholder?: string
  id?: string
  'aria-label'?: string
}) {
  const t = useTranslations('pickSecret')
  const [creating, setCreating] = useState(false)
  // 인라인으로 만든 시크릿은 즉시 선택지에 더한다(서버 프리로드 + 신규).
  const [created, setCreated] = useState<string[]>([])
  const options = useMemo(() => [...new Set([...names, ...created])].sort(), [names, created])
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Combobox
          id={id}
          value={value}
          onChange={onChange}
          options={options.map((n) => ({ value: n }))}
          placeholder={options.length > 0 ? t('selectSecret') : t('noSecrets')}
          emptyText={t('emptyText')}
          className="flex-1"
          aria-label={ariaLabel ?? t('selectSecret')}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0 gap-1"
          onClick={() => setCreating((c) => !c)}
        >
          <KeyRound className="size-3.5" /> {t('new')}
        </Button>
      </div>
      {value && !creating && hint}
      {creating && (
        <CreateSecretInline
          scope={scope}
          defaultMultiline={defaultMultiline ?? false}
          valuePlaceholder={createValuePlaceholder ?? t('secretValue')}
          onDone={(name) => {
            setCreated((c) => [...c, name])
            onCreated?.(name)
            onChange(name)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  )
}

// 인라인 시크릿 생성 — 이름(env 형식) + 값 → 저장 후 상위가 그 이름을 참조로 선택. scope 로 개인/공유 저장.
// 좁은 컨테이너(폼 그리드 셀)에도 들어가야 해서 이름/값은 세로 스택.
function CreateSecretInline({
  scope,
  defaultMultiline,
  valuePlaceholder,
  onDone,
  onCancel,
}: {
  scope: SecretPickerScope
  defaultMultiline: boolean
  valuePlaceholder: string
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const t = useTranslations('pickSecret')
  const [name, setName] = useState('')
  const [val, setVal] = useState('')
  const [show, setShow] = useState(false)
  const [multiline, setMultiline] = useState(defaultMultiline) // PEM/kubeconfig 같은 여러 줄 값 전환
  const [error, setError] = useState<string>()
  const [pending, start] = useTransition()
  const nameInvalid = name.length > 0 && !NAME_RE.test(name)

  function save() {
    setError(undefined)
    start(async () => {
      const r = await createSecretAction(name, val, scope)
      if (r.ok) onDone(name)
      else setError(r.error ?? t('saveFailed'))
    })
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-2.5">
      <p className="text-[11px] text-muted-foreground">
        {scope === 'user' ? t('scopeUser') : t('scopeWorkspace')}
      </p>
      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground">{t('nameEnvFormat')}</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="OPENAI_API_KEY"
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-[12px]"
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{t('value')}</span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setMultiline((v) => !v)}
          >
            {multiline ? t('toSingleLine') : t('toMultiline')}
          </button>
        </div>
        {multiline ? (
          <Textarea
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={valuePlaceholder}
            rows={4}
            spellCheck={false}
            className="font-mono text-[12px]"
          />
        ) : (
          <div className="relative">
            <Input
              type={show ? 'text' : 'password'}
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder={valuePlaceholder}
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
      {nameInvalid && <p className="text-[11px] text-destructive">{t('nameInvalid')}</p>}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || name.length === 0 || val.length === 0 || nameInvalid}
          onClick={save}
        >
          {pending ? t('saving') : t('saveSecret')}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
        <span className="text-[11px] text-faint">{t('valueOnce')}</span>
      </div>
    </div>
  )
}
