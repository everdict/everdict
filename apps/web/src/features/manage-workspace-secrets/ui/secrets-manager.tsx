'use client'

import { useState, useTransition } from 'react'
import { Eye, EyeOff, KeyRound, Plus } from 'lucide-react'

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
// desc = 헤더 한 줄, help = info 툴팁 상세(가이드는 인라인 금지 — 아이콘 툴팁으로).
const COPY = {
  workspace: {
    title: '워크스페이스 시크릿',
    desc: '실행·채점과 런타임 연결에 쓰는 공유 키 — 모델 키·NOMAD_TOKEN·kubeconfig 등.',
    help: '하니스 env 의 “워크스페이스” 시크릿 참조, 런타임 등록의 자격증명 이름으로 소비돼요. 각 용도엔 참조된 값만 쓰여요.',
    namePlaceholder: 'OPENAI_API_KEY',
  },
  personal: {
    title: '내 개인 시크릿',
    desc: '나만 쓰는 개인 키 — 다른 멤버는 볼 수 없어요.',
    help: '하니스 env 에서 “내 개인” 스코프로 참조하면 그 하니스는 나만 실행·열람할 수 있어요.',
    namePlaceholder: 'MY_OPENAI_API_KEY',
  },
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
  const copy = COPY[variant]
  // personal = 개인(user) 스코프(셀프 관리), workspace = 공유(admin).
  const scope: SecretScope = variant === 'personal' ? 'user' : 'workspace'
  // 프로바이더 토큰(예약 이름, 플랫폼이 소비) — 스코프에서 소비되는 것만 큐레이션.
  const providers = PROVIDER_TOKENS.filter((t) => t.scopes.includes(scope))
  // raw 목록에선 프로바이더 토큰을 제외(이중 노출 방지 — 위 큐레이션 섹션이 그 자리).
  const rawSecrets = secrets.filter((s) => !(providerTokenNames.has(s.name) && s.scope === scope))

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
            {copy.title}
            <InfoTip
              content={
                <>
                  {copy.help}
                  <br />
                  값은 at-rest 암호화되고, 저장 후에는 다시 볼 수 없어요(목록엔 이름만).
                </>
              }
            />
          </h3>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">{copy.desc}</p>
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
        {...(providers.length > 0 ? { sectionLabel: '직접 추가한 시크릿' } : {})}
      />

      {!canWrite && (
        <p className="text-[12.5px] text-muted-foreground">변경하려면 관리자 권한이 필요해요.</p>
      )}
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
        프로바이더 토큰
      </span>
      <SettingsList>
        {providers.map((t) => {
          const registered = secrets.find((s) => s.name === t.name && s.scope === scope)
          return (
            <SettingsRow
              key={t.name}
              label={
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] font-[560] text-foreground">{t.provider}</span>
                  <InfoTip
                    content={
                      <>
                        {t.help}
                        <br />
                        시크릿 이름 <code className="font-mono">{t.name}</code> 으로 저장돼요.
                      </>
                    }
                  />
                </span>
              }
              hint={
                registered
                  ? `${t.usedFor} · 등록됨 (갱신 ${new Date(registered.updatedAt).toLocaleDateString('ko-KR')})`
                  : t.usedFor
              }
            >
              {canWrite && (
                <span className="flex items-center gap-2.5">
                  {registered ? (
                    confirmName === t.name ? (
                      <>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={pending}
                          onClick={() => onDelete(t.name)}
                        >
                          삭제 확인
                        </Button>
                        <button
                          type="button"
                          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setConfirmName(undefined)}
                        >
                          취소
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setEditing(editing === t.name ? undefined : t.name)}
                        >
                          교체
                        </button>
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-destructive"
                          onClick={() => setConfirmName(t.name)}
                        >
                          삭제
                        </button>
                      </>
                    )
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditing(editing === t.name ? undefined : t.name)}
                    >
                      등록
                    </Button>
                  )}
                  <a
                    href={t.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                  >
                    발급 ↗
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
            `등록됨 ${secrets.length}개`
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
            <Plus className="size-3.5" /> 시크릿 추가
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
          아직 등록한 시크릿이 없어요.{canWrite && ' “시크릿 추가”로 넣어요.'}
        </p>
      ) : (
        <SettingsList>
          {secrets.map((s) => (
            <SettingsRow
              key={s.name}
              label={<code className="font-mono text-[13px] text-foreground">{s.name}</code>}
              hint={`갱신 ${new Date(s.updatedAt).toLocaleString('ko-KR')}`}
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
                      삭제 확인
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setConfirmName(undefined)}
                    >
                      취소
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => setConfirmName(s.name)}
                  >
                    삭제
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
            <Label htmlFor="secret-name">이름 (env 형식)</Label>
            <Input
              id="secret-name"
              value={name}
              placeholder={namePlaceholder}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-[12px]"
            />
            {nameInvalid && (
              <FieldError message="대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있어요." />
            )}
          </div>
        )}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="secret-value">값</Label>
            {!fixedName && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setMultiline((v) => !v)}
              >
                {multiline ? '한 줄 값으로' : '여러 줄 값으로 (kubeconfig 등)'}
              </button>
            )}
          </div>
          {multiline ? (
            <Textarea
              id="secret-value"
              value={value}
              placeholder="토큰이나 kubeconfig 붙여넣기"
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
                placeholder="시크릿 값"
                onChange={(e) => setValue(e.target.value)}
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
          <KeyRound className="size-3.5" /> {pending ? '저장 중…' : '저장'}
        </Button>
        <button
          type="button"
          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onCancel}
        >
          취소
        </button>
        <span className="text-[11px] text-faint">저장하면 값은 다시 볼 수 없어요.</span>
      </div>
    </div>
  )
}
