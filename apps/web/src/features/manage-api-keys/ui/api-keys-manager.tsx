'use client'

import { useEffect, useState, useTransition } from 'react'
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { ApiKeyMeta, ApiKeyScope } from '@/entities/api-key'
import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'

import { createKeyAction, revokeKeyAction } from '../api/manage-api-keys'

// scopes 미지정/admin = Full Access. 그 외는 선택 권한을 사람이 읽는 라벨로.
function scopeLabel(scopes?: ApiKeyScope[]): string {
  if (!scopes || scopes.length === 0 || scopes.includes('admin')) return 'Full Access'
  return scopes.map((s) => (s === 'read' ? 'Read' : 'Write')).join(' · ')
}

export function ApiKeysManager({ keys, canWrite }: { keys: ApiKeyMeta[]; canWrite: boolean }) {
  const t = useTranslations('manageApiKeys')
  const locale = useLocale()
  const [createOpen, setCreateOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeKeyAction(id)
      setConfirmId(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-5">
      {/* 헤더 — 설명 + 발급 액션(목록과 같은 화면, 발급은 모달로) */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-[13px] font-[560] text-foreground">{t('title')}</h3>
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            {t.rich('introRich', {
              code: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
        </div>
        {canWrite && (
          <Button size="sm" className="shrink-0" onClick={() => setCreateOpen(true)}>
            <Plus />
            {t('newKey')}
          </Button>
        )}
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {/* 목록 */}
      {keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={canWrite ? t('emptyHintWrite') : t('emptyHintRead')}
          action={
            canWrite ? (
              <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
                <Plus />
                {t('newKey')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card shadow-raise">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-3.5 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground">
                <KeyRound className="size-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-[510] text-foreground">
                    {k.label || t('unnamedKey')}
                  </span>
                  <Badge tone="outline">{scopeLabel(k.scopes)}</Badge>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
                  <code className="font-mono text-muted-foreground">{k.prefix}…</code>
                  <span>·</span>
                  <span>{new Date(k.createdAt).toLocaleString(locale)}</span>
                </div>
              </div>
              {canWrite &&
                (confirmId === k.id ? (
                  <span className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={pending}
                      onClick={() => onRevoke(k.id)}
                    >
                      {t('revokeConfirm')}
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmId(undefined)}
                    >
                      {t('close')}
                    </button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('revokeKeyAria', { name: k.label || k.prefix })}
                    onClick={() => setConfirmId(k.id)}
                  >
                    <Trash2 />
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}

      {!canWrite && keys.length > 0 && (
        <p className="text-[12px] text-muted-foreground">{t('adminRequired')}</p>
      )}

      {canWrite && <CreateKeyDialog open={createOpen} onClose={() => setCreateOpen(false)} />}
    </div>
  )
}

// 발급 모달 — 레이블 + 권한 선택 후 발급. 발급되면 같은 모달이 평문 1회 노출 단계로 전환된다.
function CreateKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('manageApiKeys')
  const locale = useLocale()
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<'full' | 'custom'>('full') // 전체 액세스 vs 범위 지정
  const [scopeRead, setScopeRead] = useState(true)
  const [scopeWrite, setScopeWrite] = useState(false)
  const [issued, setIssued] = useState<string>() // 방금 발급된 평문(1회 노출)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  // 열릴 때마다 폼 초기화(이전 발급/입력 잔상 제거).
  useEffect(() => {
    if (!open) return
    setLabel('')
    setMode('full')
    setScopeRead(true)
    setScopeWrite(false)
    setIssued(undefined)
    setCopied(false)
    setError(undefined)
  }, [open])

  function onCreate() {
    setError(undefined)
    // 범위 지정이면 선택한 scope 만, 전체 액세스면 미지정(=서버에서 Full Access).
    let scopes: ApiKeyScope[] | undefined
    if (mode === 'custom') {
      scopes = []
      if (scopeRead) scopes.push('read')
      if (scopeWrite) scopes.push('write')
      if (scopes.length === 0) {
        setError(t('selectScope'))
        return
      }
    }
    startTransition(async () => {
      const r = await createKeyAction(label, scopes)
      if (r.ok) setIssued(r.apiKey)
      else setError(r.error)
    })
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-[460px]" labelledBy="create-key-title">
      {issued ? (
        // 2단계 — 발급 완료(평문 1회 노출)
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="create-key-title" className="text-[15px] font-[560] text-foreground">
              {t('issuedTitle')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('issuedDesc')}
            </p>
          </header>
          <div className="px-5 py-4">
            <Callout tone="warning" hint={t('issuedHint')}>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">
                  {issued}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    // http(비-secure) 컨텍스트 폴백 포함 — navigator.clipboard 미존재 시 execCommand.
                    void copyText(issued, undefined, locale).then((ok) => ok && setCopied(true))
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? t('copied') : t('copy')}
                </Button>
              </div>
            </Callout>
          </div>
          <footer className="flex justify-end border-t border-border px-5 py-3.5">
            <Button size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          </footer>
        </>
      ) : (
        // 1단계 — 레이블 + 권한
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="create-key-title" className="text-[15px] font-[560] text-foreground">
              {t('createTitle')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('createDesc')}
            </p>
          </header>

          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="key-label">{t('labelOptional')}</Label>
              <Input
                id="key-label"
                value={label}
                placeholder="ci-bot, local-dev …"
                autoFocus
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('scope')}</Label>
              <div className="space-y-2">
                <ScopeOption
                  selected={mode === 'full'}
                  onSelect={() => setMode('full')}
                  name="key-access"
                  title={t('fullTitle')}
                  description={t('fullDesc')}
                />
                <ScopeOption
                  selected={mode === 'custom'}
                  onSelect={() => setMode('custom')}
                  name="key-access"
                  title={t('customTitle')}
                  description={t('customDesc')}
                >
                  <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
                    <ScopeCheck
                      checked={scopeRead}
                      onChange={setScopeRead}
                      title={t('readTitle')}
                      description={t('readDesc')}
                    />
                    <ScopeCheck
                      checked={scopeWrite}
                      onChange={setScopeWrite}
                      title={t('writeTitle')}
                      description={t('writeDesc')}
                    />
                  </div>
                </ScopeOption>
              </div>
            </div>

            {error && (
              <Callout tone="danger" className="py-1.5">
                {error}
              </Callout>
            )}
          </div>

          <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={onCreate} disabled={pending}>
              {pending ? t('issuing') : t('issue')}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  )
}

// 라디오 형태의 선택 카드 — 선택 시 인디고 보더 + 옅은 tint. custom 일 때 children(체크박스)을 펼친다.
function ScopeOption({
  selected,
  onSelect,
  name,
  title,
  description,
  children,
}: {
  selected: boolean
  onSelect: () => void
  name: string
  title: string
  description: string
  children?: React.ReactNode
}) {
  // children(체크박스)은 label 밖에 둔다 — 중첩 label 은 무효 HTML + 클릭 충돌.
  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-[background,border-color]',
        selected
          ? 'border-primary/60 bg-primary/[0.06]'
          : 'border-border bg-card hover:border-border-strong hover:bg-accent/40'
      )}
    >
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="radio"
          name={name}
          className="mt-0.5 accent-primary"
          checked={selected}
          onChange={onSelect}
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-[510] text-foreground">{title}</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
      </label>
      {selected && children}
    </div>
  )
}

// 체크박스 행 — custom 범위의 개별 권한.
function ScopeCheck({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  description: string
}) {
  return (
    <label className="flex items-start gap-2.5 text-[13px]">
      <input
        type="checkbox"
        className="mt-0.5 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block font-[510] text-foreground">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  )
}
