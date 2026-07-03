'use client'

import { useMemo, useState, useTransition } from 'react'
import { Building2, Eye, EyeOff, KeyRound, Lock, Plus, Trash2, User } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { createSecretAction } from '../api/secrets'
import type { EnvRow, SecretRefScope } from '../lib/build-spec'

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

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
          <Plus className="size-3.5" /> 변수 추가
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-faint">없음 — “변수 추가”로 넣어요.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="space-y-2 rounded-lg border bg-card p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="이름"
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
                  aria-label="삭제"
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
                  aria-label="값"
                  value={r.value}
                  onChange={(e) => set(i, { value: e.target.value })}
                  placeholder="값 (예: debug)"
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
  return (
    <div className="inline-flex shrink-0 rounded-md border bg-secondary/40 p-0.5 text-[12px]">
      {[
        { v: false, label: '값' },
        { v: true, label: '시크릿' },
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
  return (
    <div className="inline-flex shrink-0 rounded-md border bg-secondary/40 p-0.5 text-[12px]">
      {(
        [
          { v: 'user', label: '내 개인', Icon: User },
          { v: 'workspace', label: '워크스페이스', Icon: Building2 },
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

// 시크릿 참조 값 — 스코프(개인/워크스페이스) 선택 + 그 티어 시크릿에서 고르거나 인라인 생성.
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
  const [creating, setCreating] = useState(false)
  const list = scope === 'user' ? names.user : names.workspace
  return (
    <div className="space-y-2">
      <ScopeToggle scope={scope} onChange={onScopeChange} />
      <div className="flex items-center gap-1.5">
        <Combobox
          value={value}
          onChange={onChange}
          options={list.map((n) => ({ value: n }))}
          placeholder={list.length > 0 ? '시크릿 선택' : '등록된 시크릿 없음'}
          emptyText="시크릿이 없어요 — 새로 만들어요"
          className="flex-1"
          aria-label="시크릿 선택"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0 gap-1"
          onClick={() => setCreating((c) => !c)}
        >
          <KeyRound className="size-3.5" /> 새로
        </Button>
      </div>
      {value && !creating && (
        <p className="text-[11px] text-muted-foreground">
          실행할 때 {scope === 'user' ? '내 개인' : '워크스페이스'} 시크릿{' '}
          <code className="font-mono text-foreground">{value}</code> 값이 주입돼요. 스펙엔 이름만
          저장돼요.
          {scope === 'user' && ' 개인 시크릿을 쓰면 이 하니스는 나만 볼 수 있어요.'}
        </p>
      )}
      {creating && (
        <CreateSecretInline
          scope={scope}
          onDone={(name) => {
            onCreated(name, scope)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  )
}

// 인라인 시크릿 생성 — 이름(env 형식) + 값 → 저장 후 상위가 그 이름을 참조로 선택. scope 로 개인/공유 저장.
function CreateSecretInline({
  scope,
  onDone,
  onCancel,
}: {
  scope: SecretRefScope
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [val, setVal] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, start] = useTransition()
  const nameInvalid = name.length > 0 && !NAME_RE.test(name)

  function save() {
    setError(undefined)
    start(async () => {
      const r = await createSecretAction(name, val, scope)
      if (r.ok) onDone(name)
      else setError(r.error ?? '저장 실패')
    })
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-2.5">
      <p className="text-[11px] text-muted-foreground">
        {scope === 'user'
          ? '내 개인 시크릿 — 나만 쓰고 다른 멤버는 못 봐요.'
          : '워크스페이스 공유 시크릿 — 멤버가 함께 써요(관리자만 등록).'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">이름 (env 형식)</span>
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
          <span className="text-[11px] text-muted-foreground">값</span>
          <div className="relative">
            <Input
              type={show ? 'text' : 'password'}
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder="시크릿 값"
              autoComplete="off"
              spellCheck={false}
              className="pr-8 text-[12px]"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? '값 숨기기' : '값 보기'}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            >
              {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>
      {nameInvalid && (
        <p className="text-[11px] text-destructive">
          대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있어요.
        </p>
      )}
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
          {pending ? '저장 중…' : '시크릿 저장'}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          취소
        </button>
        <span className="text-[11px] text-faint">저장하면 값은 다시 볼 수 없어요.</span>
      </div>
    </div>
  )
}
