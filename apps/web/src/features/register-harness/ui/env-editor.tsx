'use client'

import { useMemo, useState } from 'react'
import { Building2, Lock, Plus, Trash2, User } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import type { EnvRow, SecretRefScope } from '../lib/build-spec'

// 워크스페이스가 로드한 시크릿 이름 — 공유(workspace) + 내 개인(user) 두 티어.
export interface ScopedSecretNames {
  workspace: string[]
  user: string[]
}

// env 편집기 — KEY + [값(리터럴) | 시크릿(참조)] 행. 시크릿 행은 스펙에 {secretRef,scope} 로 나가 평문이 안 남고,
// 공유/개인 시크릿 목록에서 고르거나 인라인으로 새로 만든다. raw 텍스트 대신 이 구조화 편집기로 env 를 넣는다.
export function EnvEditor({
  rows,
  onChange,
  secrets,
  label,
  tip,
}: {
  rows: EnvRow[]
  onChange: (rows: EnvRow[]) => void
  secrets: ScopedSecretNames
  label: string
  tip: React.ReactNode
}) {
  const t = useTranslations('registerHarness')
  // 인라인으로 만든 시크릿은 스코프별로 더해 즉시 선택 가능하게 한다(서버 프리로드 + 신규).
  const [created, setCreated] = useState<{ name: string; scope: SecretRefScope }[]>([])
  const names = useMemo<ScopedSecretNames>(
    () => ({
      workspace: [
        ...new Set([
          ...secrets.workspace,
          ...created.filter((c) => c.scope === 'workspace').map((c) => c.name),
        ]),
      ].sort(),
      user: [
        ...new Set([
          ...secrets.user,
          ...created.filter((c) => c.scope === 'user').map((c) => c.name),
        ]),
      ].sort(),
    }),
    [secrets, created]
  )
  const set = (i: number, patch: Partial<EnvRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <span className="text-[11px] font-[510] text-muted-foreground">{label}</span>
          <InfoTip content={tip} />
        </span>
        <button
          type="button"
          onClick={() => onChange([...rows, { key: '', secret: false, value: '' }])}
          className="flex items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
        >
          <Plus className="size-3.5" /> {t('addVariable')}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-faint">{t('envEmpty')}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="space-y-2 rounded-lg border bg-card p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={t('name')}
                  value={r.key}
                  onChange={(e) => set(i, { key: e.target.value })}
                  placeholder="NAME"
                  spellCheck={false}
                  className="flex-1 font-mono text-[12px]"
                />
                <SourceToggle
                  secret={r.secret}
                  // 소스를 바꾸면 값은 초기화(리터럴 ↔ 시크릿 이름은 서로 다른 의미). 시크릿 기본 스코프=workspace.
                  onChange={(secret) => set(i, { secret, value: '', scope: 'workspace' })}
                />
                <button
                  type="button"
                  aria-label={t('remove')}
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              {r.secret ? (
                <SecretValue
                  scope={r.scope ?? 'workspace'}
                  names={names}
                  value={r.value}
                  onScopeChange={(scope) => set(i, { scope, value: '' })}
                  onChange={(v) => set(i, { value: v })}
                  onCreated={(name, scope) => {
                    setCreated((c) => [...c, { name, scope }])
                    set(i, { value: name, scope })
                  }}
                />
              ) : (
                <Input
                  aria-label={t('sourceValue')}
                  value={r.value}
                  onChange={(e) => set(i, { value: e.target.value })}
                  placeholder={t('valuePlaceholder')}
                  className="text-[12px]"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 값(리터럴) | 시크릿(참조) 세그먼트 토글.
function SourceToggle({
  secret,
  onChange,
}: {
  secret: boolean
  onChange: (secret: boolean) => void
}) {
  const t = useTranslations('registerHarness')
  return (
    <div className="inline-flex shrink-0 rounded-md border bg-secondary/40 p-0.5 text-[12px]">
      {[
        { v: false, label: t('sourceValue') },
        { v: true, label: t('sourceSecret') },
      ].map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            'rounded px-2 py-0.5 transition-colors',
            secret === o.v
              ? 'bg-card font-[510] text-foreground shadow-raise'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.v ? (
            <span className="inline-flex items-center gap-1">
              <Lock className="size-3" />
              {o.label}
            </span>
          ) : (
            o.label
          )}
        </button>
      ))}
    </div>
  )
}

// 개인(user) | 워크스페이스(workspace) 스코프 세그먼트.
function ScopeToggle({
  scope,
  onChange,
}: {
  scope: SecretRefScope
  onChange: (scope: SecretRefScope) => void
}) {
  const t = useTranslations('registerHarness')
  return (
    <div className="inline-flex shrink-0 rounded-md border bg-secondary/40 p-0.5 text-[12px]">
      {(
        [
          { v: 'user', label: t('scopeUser'), Icon: User },
          { v: 'workspace', label: t('scopeWorkspace'), Icon: Building2 },
        ] as const
      ).map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors',
            scope === o.v
              ? 'bg-card font-[510] text-foreground shadow-raise'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <o.Icon className="size-3" />
          {o.label}
        </button>
      ))}
    </div>
  )
}

// 시크릿 참조 값 — 스코프(개인/워크스페이스) 선택 + 그 티어 시크릿에서 고르거나 인라인 생성(SecretPicker 공용).
function SecretValue({
  scope,
  names,
  value,
  onScopeChange,
  onChange,
  onCreated,
}: {
  scope: SecretRefScope
  names: ScopedSecretNames
  value: string
  onScopeChange: (scope: SecretRefScope) => void
  onChange: (v: string) => void
  onCreated: (name: string, scope: SecretRefScope) => void
}) {
  const t = useTranslations('registerHarness')
  const list = scope === 'user' ? names.user : names.workspace
  return (
    <div className="space-y-2">
      <ScopeToggle scope={scope} onChange={onScopeChange} />
      <SecretPicker
        value={value}
        onChange={onChange}
        names={list}
        scope={scope}
        // 생성을 상위(EnvEditor)로 올려 다른 env 행에서도 바로 선택 가능하게 한다.
        onCreated={(name) => onCreated(name, scope)}
        hint={
          <p className="text-[11px] text-muted-foreground">
            {t('secretHintPrefix', {
              scope: scope === 'user' ? t('scopeUser') : t('scopeWorkspace'),
            })}{' '}
            <code className="font-mono text-foreground">{value}</code> {t('secretHintSuffix')}
            {scope === 'user' && ` ${t('secretHintUserOnly')}`}
          </p>
        }
      />
    </div>
  )
}
