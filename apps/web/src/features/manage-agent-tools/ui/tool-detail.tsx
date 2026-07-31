'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Container, KeyRound, Loader2, Terminal, Zap } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { createSecretAction, SecretPicker } from '@/features/pick-secret'
import { CodeTryPanel } from '@/features/publish-capability'
import type { AgentToolDetail, AgentToolFunction, AgentToolSecret } from '@/entities/agent-tool'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { CodeEditor } from '@/shared/ui/code-editor'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { setAgentToolAction } from '../api/set-agent-tool'
import { bindAgentToolSecretsAction, probeAgentToolAction } from '../api/tool-detail'

// Settings › Agent › Tools › 상세 — 목록이 스위치라면 여기는 그 스위치 뒤의 설명이다. 사용자가 이 도구를 신뢰할지
// 정하기 위해 필요한 것: 어떻게 도달하는지(transport), 모델 앞에 어떤 function 을 어떤 이름으로 놓는지, 모델이 읽는
// description 이 정확히 무엇인지, 어떤 시크릿을 필요로 하고 그게 나에게 풀리는지, 그리고 정말 도는지(연결 테스트 ·
// 예제 실행). 편집은 여기서 폼으로 하지 않는다 — 도구 뒤의 capability 를 대화에서 고치고 버전을 올린다(상세 스킬과 동형).

export function ToolDetail({
  tool: initial,
  secretNames,
  canBind,
  actions,
}: {
  tool: AgentToolDetail
  secretNames: string[] // 내가 닿는 시크릿 이름(워크스페이스 + 개인) — 바인딩 피커의 후보
  canBind: boolean // agents:write — 서버가 최종 강제, 여기선 컨트롤 숨김
  actions?: ReactNode // "대화로 편집하기" 등 앱 레이어가 조립해 내려주는 진입
}) {
  const [tool, setTool] = useState(initial)

  return (
    <div className="space-y-6">
      <MetaStrip tool={tool} />

      <div className="flex flex-wrap items-center gap-2">{actions}</div>

      <UsageSection tool={tool} onChanged={setTool} />
      <HowItWorksSection tool={tool} />
      <ModelViewSection tool={tool} />
      <FunctionsSection tool={tool} />
      {tool.secrets.length > 0 && (
        <SecretsSection tool={tool} secretNames={secretNames} canBind={canBind} onBound={setTool} />
      )}
      {tool.code !== undefined && <SourceSection tool={tool} />}
    </div>
  )
}

// 메타 스트립 — 종류 · 출처 · 범위 · 버전 · 쓰기 여부. 빈 값은 렌더하지 않는다(상세뷰 관습).
function MetaStrip({ tool }: { tool: AgentToolDetail }) {
  const t = useTranslations('agentTools')
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
      <Badge tone="outline">{t(`type_${tool.type}`)}</Badge>
      <Badge tone={tool.origin === 'builtin' ? 'info' : 'outline'}>
        {t(`origin_${tool.origin}`)}
      </Badge>
      <Badge tone="outline">{t(`scope_${tool.scope}`)}</Badge>
      {tool.writes && <Badge tone="warning">{t('writes')}</Badge>}
      {tool.capability && (
        <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground ring-1 ring-inset ring-border">
          {tool.capability.source}/{tool.capability.id}@{tool.capability.version}
        </code>
      )}
      {tool.tags.map((tag) => (
        <span
          key={tag}
          className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] ring-1 ring-inset ring-border"
        >
          #{tag}
        </span>
      ))}
    </div>
  )
}

// 이 도구를 내 에이전트가 지금 들고 있는가 — 목록의 토글과 같은 결정을, 상세를 보는 자리에서.
function UsageSection({
  tool,
  onChanged,
}: {
  tool: AgentToolDetail
  onChanged: (tool: AgentToolDetail) => void
}) {
  const t = useTranslations('agentTools')
  const [pending, start] = useTransition()
  const overridden = tool.enabled !== tool.baseline
  const shadowed = tool.shadowedBy !== undefined && !tool.enabled

  const apply = (enabled: boolean | null) => {
    const next = enabled === null ? tool.baseline : enabled
    start(async () => {
      const r = await setAgentToolAction(tool.key, enabled)
      if (r.ok) onChanged({ ...tool, enabled: next })
      else toast.error(r.error ?? t('saveFailed'))
    })
  }

  return (
    <SettingsList>
      <SettingsRow
        label={t('useTool')}
        hint={shadowed ? t('shadowed') : overridden ? t('overridden') : t('useToolHint')}
      >
        {overridden && (
          <button
            type="button"
            onClick={() => apply(null)}
            disabled={pending}
            className="text-[12px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            {t('followWorkspace')}
          </button>
        )}
        <input
          type="checkbox"
          className={cn('accent-primary', pending && 'opacity-50')}
          checked={tool.enabled}
          disabled={pending}
          onChange={(e) => apply(e.target.checked)}
          aria-label={t('useTool')}
        />
      </SettingsRow>
    </SettingsList>
  )
}

// 어떻게 동작하는가 — 런타임이 이 도구에 도달하는 방식(transport) + 이 도구가 어디서 왔는지(origin). 둘 다 한 문장씩,
// 그리고 실제 목적지(URL · 이미지 · 언어)를 그대로 보여 준다.
function HowItWorksSection({ tool }: { tool: AgentToolDetail }) {
  const t = useTranslations('agentTools')
  const { transport } = tool
  return (
    <Section title={t('howTitle')}>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t(`howTransport_${transport.kind}`)}
      </p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t(`howOrigin_${tool.origin}`)}
      </p>
      <SettingsList>
        {transport.kind === 'http' && (
          <SettingsRow label={t('endpointLabel')}>
            <code className="break-all font-mono text-[12px]">{transport.url}</code>
          </SettingsRow>
        )}
        {transport.kind === 'stdio' && (
          <SettingsRow label={t('imageLabel')}>
            <code className="break-all font-mono text-[12px]">
              <Container className="mr-1 inline size-3.5" />
              {transport.image}
              {transport.args.length > 0 ? ` ${transport.args.join(' ')}` : ''}
            </code>
          </SettingsRow>
        )}
        {transport.kind === 'code' && (
          <>
            <SettingsRow label={t('languageLabel')}>
              <code className="font-mono text-[12px]">
                <Terminal className="mr-1 inline size-3.5" />
                {transport.language}
              </code>
            </SettingsRow>
            {transport.timeoutSec !== undefined && (
              <SettingsRow label={t('timeoutLabel')}>
                <span className="text-[12px]">
                  {t('timeoutSeconds', { n: transport.timeoutSec })}
                </span>
              </SettingsRow>
            )}
            {transport.image !== undefined && (
              <SettingsRow label={t('sandboxImageLabel')}>
                <code className="break-all font-mono text-[12px]">{transport.image}</code>
              </SettingsRow>
            )}
          </>
        )}
      </SettingsList>
    </Section>
  )
}

// 모델이 읽는 문장 그대로 — 도구를 언제 고를지는 이 한 줄이 정한다. 편집하지 않고 있는 그대로 보여 주는 게 요점.
function ModelViewSection({ tool }: { tool: AgentToolDetail }) {
  const t = useTranslations('agentTools')
  return (
    <Section title={t('modelSeesTitle')} hint={t('modelSeesHint')}>
      <blockquote className="rounded-lg border border-border bg-secondary/30 p-3 text-[13px] leading-relaxed">
        {tool.description}
      </blockquote>
    </Section>
  )
}

// 이 도구가 포함하는 function 들. 선언값(저자가 적은 provides / code 도구 자신)이 기본이고, MCP 도구는 연결 테스트로
// 서버가 진짜 제공하는 목록으로 교체한다 — 선언과 현실이 어긋나는 것을 볼 수 있는 유일한 자리.
function FunctionsSection({ tool }: { tool: AgentToolDetail }) {
  const t = useTranslations('agentTools')
  const [live, setLive] = useState<AgentToolFunction[] | null>(null)
  const [probe, setProbe] = useState<{ ok: boolean; detail: string; missing: string[] } | null>(
    null
  )
  const [pending, start] = useTransition()

  const runProbe = () =>
    start(async () => {
      const r = await probeAgentToolAction(tool.key)
      if (!r.ok || !r.result) {
        toast.error(r.error ?? t('probeFailed'))
        return
      }
      setProbe({
        ok: r.result.reachable,
        detail: r.result.detail,
        missing: r.result.missingSecrets,
      })
      setLive(r.result.reachable ? r.result.functions : null)
    })

  const functions = live ?? tool.functions
  return (
    <Section
      title={t('functionsTitle')}
      hint={live ? t('functionsLiveNote') : t('functionsDeclaredNote')}
      action={
        tool.probeable ? (
          <Button variant="secondary" size="sm" onClick={runProbe} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Zap />}
            {pending ? t('testing') : t('testConnection')}
          </Button>
        ) : undefined
      }
    >
      {probe && (
        <Callout tone={probe.ok ? 'info' : 'danger'}>
          <span className="flex items-start gap-1.5">
            {probe.ok ? (
              <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>
              {probe.detail}
              {probe.missing.length > 0 &&
                ` · ${t('missingSecrets', { names: probe.missing.join(', ') })}`}
            </span>
          </span>
        </Callout>
      )}
      {functions.length === 0 ? (
        <p className="text-[12.5px] text-faint">
          {tool.probeable ? t('functionsUnknown') : t('functionsEmpty')}
        </p>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border bg-card">
          {functions.map((fn) => (
            <FunctionRow key={fn.bridgedName} fn={fn} />
          ))}
        </ul>
      )}
    </Section>
  )
}

function FunctionRow({ fn }: { fn: AgentToolFunction }) {
  const t = useTranslations('agentTools')
  const [open, setOpen] = useState(false)
  const hasSchema = fn.parametersSchema !== undefined
  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-[13px] font-[560] text-foreground">{fn.bridgedName}</code>
        <Badge tone={fn.readOnly ? 'success' : 'warning'}>
          {t(fn.readOnly ? 'fnReadOnly' : 'fnWrites')}
        </Badge>
        {hasSchema && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11.5px] text-link underline-offset-2 hover:underline"
          >
            {open ? t('hideParameters') : t('showParameters')}
          </button>
        )}
      </div>
      {fn.description && (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{fn.description}</p>
      )}
      {open && hasSchema && (
        <pre className="max-h-56 overflow-auto rounded-md bg-secondary/50 p-2 font-mono text-[11.5px] leading-relaxed">
          {JSON.stringify(fn.parametersSchema, null, 2)}
        </pre>
      )}
    </li>
  )
}

// 필요한 시크릿 — 모든 채널이 바인딩 저장처를 갖는다(채택 capability=CapabilityRef · 직접 배선 서버=authSecret ·
// 기본 제공/미채택 발행물=AgentSpec.toolSecretBindings 오버레이). 그래서 화면은 권한으로만 갈린다: agents:write 면
// 기존 시크릿을 골라 잇거나 인라인으로 새로 만들고(피커), 아니면 도구가 읽는 이름 그대로 값을 넣어 주는 것이 해결이다.
function SecretsSection({
  tool,
  secretNames,
  canBind,
  onBound,
}: {
  tool: AgentToolDetail
  secretNames: string[]
  canBind: boolean
  onBound: (tool: AgentToolDetail) => void
}) {
  const t = useTranslations('agentTools')
  const bindable = tool.bindable && canBind
  return (
    <Section
      title={t('secretsTitle')}
      hint={bindable ? t('secretsBindHint') : t('secretsNameHint')}
    >
      <div className="space-y-3">
        {tool.secrets.map((secret) =>
          bindable ? (
            <BindSecretRow
              key={secret.name}
              toolKey={tool.key}
              secret={secret}
              secretNames={secretNames}
              onBound={onBound}
            />
          ) : (
            <NamedSecretRow key={secret.name} secret={secret} />
          )
        )}
      </div>
    </Section>
  )
}

// 바인딩 가능한 경우 — 선언 이름을 내 시크릿 이름에 잇는다. 값은 오가지 않는다(피커는 이름만 고른다).
function BindSecretRow({
  toolKey,
  secret,
  secretNames,
  onBound,
}: {
  toolKey: string
  secret: AgentToolSecret
  secretNames: string[]
  onBound: (tool: AgentToolDetail) => void
}) {
  const t = useTranslations('agentTools')
  const [value, setValue] = useState(secret.boundTo)
  const [pending, start] = useTransition()
  const dirty = value !== secret.boundTo

  const save = () =>
    start(async () => {
      const r = await bindAgentToolSecretsAction(toolKey, { [secret.name]: value })
      if (r.ok && r.tool) {
        onBound(r.tool)
        toast.success(t('bindSaved'))
      } else {
        toast.error(r.error ?? t('bindFailed'))
      }
    })

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <SecretHeader secret={secret} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[14rem] flex-1">
          <SecretPicker
            value={value}
            onChange={setValue}
            names={secretNames}
            scope="workspace"
            aria-label={t('bindLabel', { name: secret.name })}
          />
        </div>
        <Button size="sm" onClick={save} disabled={pending || !dirty || value.length === 0}>
          {pending ? t('binding') : t('bindSave')}
        </Button>
      </div>
    </div>
  )
}

// 이름으로 읽는 경우 — 고를 것이 없다. 정확히 이 이름의 시크릿에 값을 넣어 주는 것이 전부라서, 이름은 고정하고 값만 받는다.
function NamedSecretRow({ secret }: { secret: AgentToolSecret }) {
  const t = useTranslations('agentTools')
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<'workspace' | 'user'>('workspace')
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  const save = () =>
    start(async () => {
      const r = await createSecretAction(secret.boundTo, value, scope)
      if (r.ok) {
        setSaved(true)
        setOpen(false)
        setValue('')
        toast.success(t('secretStored', { name: secret.boundTo }))
      } else {
        toast.error(r.error ?? t('bindFailed'))
      }
    })

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <SecretHeader secret={secret} overrideResolved={saved ? true : undefined} />
      {!secret.resolved && !saved && !open && (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <KeyRound className="size-3.5" />
          {t('setSecretValue')}
        </Button>
      )}
      {open && (
        <div className="space-y-2 rounded-md border border-dashed bg-muted/30 p-2.5">
          <p className="text-[11.5px] text-muted-foreground">
            {t('setSecretValueHint', { name: secret.boundTo })}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1 space-y-1">
              <Label htmlFor={`secret-${secret.name}`}>{t('secretValueLabel')}</Label>
              <Input
                id={`secret-${secret.name}`}
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="text-[12px]"
              />
            </div>
            <Combobox
              options={[
                { value: 'workspace', label: t('scopeWorkspaceSecret') },
                { value: 'user', label: t('scopePersonalSecret') },
              ]}
              value={scope}
              onChange={(v) => setScope(v === 'user' ? 'user' : 'workspace')}
              className="w-[150px]"
              aria-label={t('secretScopeLabel')}
            />
            <Button size="sm" onClick={save} disabled={pending || value.length === 0}>
              {pending ? t('binding') : t('bindSave')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SecretHeader({
  secret,
  overrideResolved,
}: {
  secret: AgentToolSecret
  overrideResolved?: boolean
}) {
  const t = useTranslations('agentTools')
  const resolved = overrideResolved ?? secret.resolved
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-[13px] font-[560]">{secret.name}</code>
        <Badge tone={resolved ? 'success' : 'danger'}>
          {t(resolved ? 'secretResolved' : 'secretMissing')}
        </Badge>
        {secret.boundTo !== secret.name && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
            {t('boundTo')}
            <code className="font-mono">{secret.boundTo}</code>
          </span>
        )}
      </div>
      {secret.description && (
        <p className="text-[12px] leading-relaxed text-muted-foreground">{secret.description}</p>
      )}
    </div>
  )
}

// code 도구의 고정된 소스 + 예제 + 실제 1회 실행. "코드만 읽고 신뢰하지 않는다"는 스토어의 검증 루프를 그대로 가져온다.
function SourceSection({ tool }: { tool: AgentToolDetail }) {
  const t = useTranslations('agentTools')
  const capability = tool.capability
  const language = tool.transport.kind === 'code' ? tool.transport.language : 'python'
  const firstExample = tool.examples[0]
  return (
    <Section title={t('sourceTitle')} hint={t('sourceHint')}>
      <CodeEditor
        value={tool.code ?? ''}
        language={language}
        readOnly
        minHeight="140px"
        maxHeight="360px"
        aria-label={t('sourceTitle')}
      />
      {tool.examples.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11.5px] font-[510] text-muted-foreground">{t('examplesTitle')}</p>
          {tool.examples.map((example, i) => (
            <div key={i} className="text-[12px] text-muted-foreground">
              {example.name && <span className="font-[510] text-foreground">{example.name}: </span>}
              <code className="break-all font-mono">{JSON.stringify(example.input)}</code>
              {example.note ? ` — ${example.note}` : ''}
            </div>
          ))}
        </div>
      )}
      {capability ? (
        <CodeTryPanel
          showCheck={false}
          buildTarget={() => ({ ref: capability })}
          initialInput={firstExample ? JSON.stringify(firstExample.input, null, 2) : '{}'}
        />
      ) : null}
    </Section>
  )
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[13.5px] font-[510] text-foreground">{title}</h2>
          {hint && <InfoTip content={hint} />}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
