'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Play, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'

import { saveAgentAction } from '@/features/manage-agent'
import {
  agentDraftSchema,
  TRIGGERABLE_EVENT_KINDS,
  type AgentDraft,
  type AgentSpec,
} from '@/entities/agent-spec'
import { platformEventListSchema, type PlatformEvent } from '@/entities/platform-event'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Combobox } from '@/shared/ui/combobox'
import { Input } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'

// 대화형 에이전트 크래프팅 스튜디오(agent-automation B2/B3 — analysis-studio 패턴의 크래프팅판).
// 왼쪽 = 만들어지는 에이전트(이 캔버스), 오른쪽 = 챗 패널. 연결은 같은 창 CustomEvent 버스:
//  · 패널 → 캔버스: SSE `agent_draft` → 'everdict:agent-draft' → 여기서 적용(라이브 반영)
//  · 캔버스 → 패널: 전송 직전 'everdict:agent-draft-request' → 'everdict:agent-draft-state' 로 현 draft 회신
//    (멀티턴 개선이 수동 편집을 포함한 라이브 상태에 근거하게 — canvas-state 피드백과 동일 계약)
// 크래프트되는 에이전트는 공유 에이전틱 루프 위의 선언(AgentSpec)일 뿐 — 코드/별도 런타임이 아니다.

const tryResultSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['assistant', 'tool']),
      content: z.string(),
      toolCalls: z.array(z.object({ name: z.string(), arguments: z.string() })).optional(),
      toolCallId: z.string().optional(),
    })
  ),
  wouldHave: z.array(z.object({ name: z.string(), input: z.unknown() })),
})
type TryResult = z.infer<typeof tryResultSchema>

export function AgentCraftStudio({
  agentId,
  initialSpec,
}: {
  agentId?: string
  initialSpec?: AgentSpec | null
}) {
  const t = useTranslations('craftAgent')
  const [draft, setDraft] = useState<AgentDraft>(() =>
    initialSpec
      ? {
          id: initialSpec.id,
          ...(initialSpec.description !== undefined
            ? { description: initialSpec.description }
            : {}),
          ...(initialSpec.instructions !== undefined
            ? { instructions: initialSpec.instructions }
            : {}),
          ...(initialSpec.task !== undefined ? { task: initialSpec.task } : {}),
          triggers: initialSpec.triggers,
          ...(initialSpec.permissionMode !== undefined
            ? { permissionMode: initialSpec.permissionMode }
            : {}),
          ...(initialSpec.model !== undefined ? { model: initialSpec.model } : {}),
        }
      : { permissionMode: 'default' }
  )
  const [enabled, setEnabled] = useState(initialSpec?.enabled ?? false)
  const [saveState, setSaveState] = useState<{ version?: string; error?: string } | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // 캔버스 ↔ 챗 패널 버스 — 현 draft 를 회신(announce)하고, 패널이 중계한 SSE 패치를 적용한다.
  useEffect(() => {
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent('everdict:agent-draft-state', {
          detail: { draft: draftRef.current, ...(agentId ? { agentId } : {}) },
        })
      )
    }
    const onApply = (e: Event) => {
      const parsed = agentDraftSchema.safeParse((e as CustomEvent<unknown>).detail)
      if (parsed.success) setDraft(parsed.data)
    }
    window.addEventListener('everdict:agent-draft-request', announce)
    window.addEventListener('everdict:agent-draft', onApply)
    announce()
    return () => {
      window.removeEventListener('everdict:agent-draft-request', announce)
      window.removeEventListener('everdict:agent-draft', onApply)
      window.dispatchEvent(new CustomEvent('everdict:agent-draft-state', { detail: null }))
    }
  }, [agentId])
  // draft 가 바뀔 때마다 재告知 — 패널의 "draft linked" 상태와 다음 턴 캡처가 항상 최신을 본다.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('everdict:agent-draft-state', {
        detail: { draft, ...(agentId ? { agentId } : {}) },
      })
    )
  }, [draft, agentId])

  const patch = useCallback((p: Partial<AgentDraft>) => {
    setDraft((prev) => ({ ...prev, ...p }))
  }, [])

  const save = useCallback(async () => {
    const id = draft.id?.trim()
    if (!id) {
      setSaveState({ error: t('idRequired') })
      return
    }
    // 기존 스펙의 도구 채널(mcpServers/capabilities/disabledDefaults/tags)은 보존하고 draft 를 얹는다.
    const body = {
      ...(draft.description !== undefined ? { description: draft.description } : {}),
      ...(draft.instructions !== undefined ? { instructions: draft.instructions } : {}),
      ...(draft.task !== undefined ? { task: draft.task } : {}),
      triggers: draft.triggers ?? [],
      ...(draft.permissionMode !== undefined ? { permissionMode: draft.permissionMode } : {}),
      ...(draft.model !== undefined ? { model: draft.model } : {}),
      mcpServers: initialSpec?.mcpServers ?? [],
      capabilities: initialSpec?.capabilities ?? [],
      disabledDefaults: initialSpec?.disabledDefaults ?? [],
      tags: initialSpec?.tags ?? [],
      enabled,
    }
    const r = await saveAgentAction(id, body)
    setSaveState(r.ok ? { version: r.version } : { error: r.error })
  }, [draft, enabled, initialSpec, t])

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" aria-hidden />
          <Input
            value={draft.id ?? ''}
            onChange={(e) => patch({ id: e.target.value })}
            placeholder={t('idPlaceholder')}
            disabled={agentId !== undefined}
            className="max-w-xs font-mono"
          />
          {draft.permissionMode ? <Badge tone="outline">{draft.permissionMode}</Badge> : null}
          {enabled ? <Badge tone="success">{t('enabled')}</Badge> : <Badge>{t('disabled')}</Badge>}
        </div>
        <Input
          value={draft.description ?? ''}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder={t('descriptionPlaceholder')}
        />
        <Field label={t('task')} hint={t('taskHint')}>
          <textarea
            value={draft.task ?? ''}
            onChange={(e) => patch({ task: e.target.value })}
            rows={6}
            className="w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-xs"
          />
        </Field>
        <Field label={t('instructions')} hint={t('instructionsHint')}>
          <textarea
            value={draft.instructions ?? ''}
            onChange={(e) => patch({ instructions: e.target.value })}
            rows={4}
            className="w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-xs"
          />
        </Field>
        <Field label={t('triggers')} hint={t('triggersHint')}>
          <div className="space-y-1.5">
            {(draft.triggers ?? []).map((trigger, i) => (
              <div
                key={`${trigger.kinds.join(',')}-${i}`}
                className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-xs"
              >
                {trigger.kinds.map((kind) => (
                  <Badge key={kind} tone="info">
                    {kind}
                  </Badge>
                ))}
                {trigger.filters.map((f) => (
                  <code
                    key={`${f.field}${f.op}`}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono"
                  >
                    {f.field} {f.op} {f.value === undefined ? '' : String(f.value)}
                  </code>
                ))}
                <button
                  type="button"
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  aria-label={t('removeTrigger')}
                  onClick={() =>
                    patch({ triggers: (draft.triggers ?? []).filter((_, idx) => idx !== i) })
                  }
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            ))}
            <Combobox
              options={TRIGGERABLE_EVENT_KINDS.map((kind) => ({ value: kind }))}
              value=""
              onChange={(kind) =>
                patch({
                  triggers: [
                    ...(draft.triggers ?? []),
                    { kinds: [kind as (typeof TRIGGERABLE_EVENT_KINDS)[number]], filters: [] },
                  ],
                })
              }
              placeholder={t('addTrigger')}
            />
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('permissionMode')}>
            <Combobox
              options={['default', 'auto', 'bypass', 'plan'].map((m) => ({ value: m }))}
              value={draft.permissionMode ?? 'default'}
              onChange={(m) => patch({ permissionMode: m as AgentDraft['permissionMode'] })}
            />
          </Field>
          <Field label={t('model')}>
            <Input
              value={draft.model ?? ''}
              onChange={(e) => patch({ model: e.target.value || undefined })}
              placeholder={t('modelPlaceholder')}
            />
          </Field>
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 pt-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('enableOnSave')}
          </label>
          <Button size="sm" onClick={() => void save()}>
            {t('save')}
          </Button>
          {saveState?.version ? (
            <span className="text-xs text-muted-foreground">
              {t('savedAs', { version: saveState.version })}
            </span>
          ) : null}
          {saveState?.error ? (
            <span className="text-xs text-destructive">{saveState.error}</span>
          ) : null}
        </div>
      </Card>
      <TryPanel draft={draft} />
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
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground/70">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

// 리플레이 try 패널(B3) — 실제 과거 이벤트를 골라 현 draft 를 섀도 실행한다. 대화의 try_agent_draft 와
// 같은 백엔드(/agent/agents/try); 캔버스에서도 원클릭으로 검증할 수 있게 하는 수동 경로.
function TryPanel({ draft }: { draft: AgentDraft }) {
  const t = useTranslations('craftAgent')
  const [events, setEvents] = useState<PlatformEvent[]>([])
  const [selected, setSelected] = useState<PlatformEvent | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TryResult | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/events?limit=10')
        if (!res.ok) return
        setEvents(platformEventListSchema.parse(await res.json()).events)
      } catch {
        // 이벤트 로그 없음(빈 워크스페이스) — 패널은 빈 목록으로 남는다
      }
    })()
  }, [])

  const run = useCallback(async () => {
    if (!selected) return
    setRunning(true)
    setResult(null)
    try {
      const res = await fetch('/api/agent/try', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draft: {
            ...(draft.instructions !== undefined ? { instructions: draft.instructions } : {}),
            ...(draft.task !== undefined ? { task: draft.task } : {}),
          },
          event: {
            kind: selected.kind,
            message: selected.message,
            subject: selected.subject,
            payload: selected.payload,
          },
        }),
      })
      if (res.ok) {
        const parsed = tryResultSchema.safeParse(await res.json())
        if (parsed.success) setResult(parsed.data)
      }
    } finally {
      setRunning(false)
    }
  }, [draft, selected])

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t('tryTitle')}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!selected || running}
          onClick={() => void run()}
        >
          <Play className="size-3.5" aria-hidden />
          {running ? t('running') : t('run')}
        </Button>
      </div>
      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noEvents')}</p>
      ) : (
        <div className="space-y-1">
          {events.map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={() => setSelected(event)}
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs ${
                selected?.id === event.id ? 'border-primary/60 bg-primary/5' : 'border-border/60'
              }`}
            >
              <Badge tone="info">{event.kind}</Badge>
              <span className="truncate text-muted-foreground">{event.message}</span>
            </button>
          ))}
        </div>
      )}
      {result ? (
        <div className="space-y-2 border-t border-border/60 pt-3 text-xs">
          <div>
            <span className="font-medium">{t('wouldHave')}</span>
            {result.wouldHave.length === 0 ? (
              <span className="ml-1.5 text-muted-foreground">{t('none')}</span>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {result.wouldHave.map((w, i) => (
                  <li key={`${w.name}-${i}`}>
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">{w.name}</code>{' '}
                    <span className="text-muted-foreground">{JSON.stringify(w.input)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(() => {
            const answer = [...result.messages]
              .reverse()
              .find((m) => m.role === 'assistant' && m.content.length > 0)
            return answer ? <Markdown content={answer.content} className="text-xs" /> : null
          })()}
        </div>
      ) : null}
    </Card>
  )
}
