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

// Settings › Agent › Tools › detail — where the list is a switch, this is the explanation behind that switch. What a user needs in order to
// decide whether to trust this tool: how it is reached (transport), what function it puts in front of the model and under what name, exactly
// what description the model reads, which secrets it needs and whether those resolve for me, and whether it actually runs (a connection test ·
// running an example). Editing is not a form here — the capability BEHIND the tool is edited in conversation and version-stamped (isomorphic to the skill detail).

export function ToolDetail({
  tool: initial,
  secretNames,
  canBind,
  actions,
}: {
  tool: AgentToolDetail
  secretNames: string[] // the secret names I can reach (workspace + personal) — the binding picker's candidates
  canBind: boolean // agents:write — the server enforces finally; here it only hides the control
  actions?: ReactNode // entries the app layer assembles and passes down, such as "edit by conversation"
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

// The meta strip — kind · origin · scope · version · whether it writes. An empty value is not rendered (the detail-view convention).
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

// Does my agent hold this tool right now — the same decision as the list toggle, made from where you are reading the detail.
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

// How it works — the way the runtime reaches this tool (transport) plus where the tool came from (origin). One sentence each,
// and the real destination (URL · image · language) shown verbatim.
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

// The sentence the model reads, verbatim — this one line decides WHEN the tool is chosen. Showing it as-is rather than editing it is the point.
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

// The functions this tool contains. The DECLARED set is the default (the `provides` its author wrote, or the code tool itself), and an MCP
// tool replaces it with what the server really offers via a connection test — the only place a divergence between declaration and reality is visible.
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

// The required secrets — every channel has somewhere to store a binding (an adopted capability = CapabilityRef · a hand-wired server =
// authSecret · a built-in default or an unadopted publication = the AgentSpec.toolSecretBindings overlay). So the screen splits on PERMISSION
// alone: with agents:write you pick an existing secret or create one inline (the picker); without it, the fix is to put a value under the exact name the tool reads.
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

// The bindable case — join the declared name to one of my secret names. No value travels (the picker chooses a NAME only).
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

// The read-by-name case — there is nothing to pick. Putting a value under exactly this name is the whole fix, so the name is fixed and only the value is taken.
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

// A code tool's pinned source plus its examples plus one real execution. It carries over the store's verification loop: "nothing is trusted on a reading of the code alone".
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
