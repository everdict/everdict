'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, Eye, Square } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import {
  agentMessageListSchema,
  agentRunListSchema,
  type AgentMessage,
  type AgentRunStatus,
  type AgentSession,
} from '@/entities/agent-session'
import { fmtTimeAgo } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Markdown } from '@/shared/ui/markdown'

// Fleet view (docs/architecture/agent-automation.md A5): the workspace's agent runs, live. Polls the BFF for
// status; a member can stop a live run, and any member can drill into a run's transcript (headless runs are
// workspace-visible by design — observability, not private chat history).
const POLL_MS = 5000

const STATUS_TONE: Record<AgentRunStatus, 'neutral' | 'success' | 'danger' | 'warning' | 'info'> = {
  running: 'info',
  awaiting_approval: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

export function AgentFleet({
  initialRuns,
  canStop,
}: {
  initialRuns: AgentSession[]
  canStop: boolean
}) {
  const t = useTranslations('agentFleet')
  const locale = useLocale()
  const [runs, setRuns] = useState<AgentSession[]>(initialRuns)
  const [openRun, setOpenRun] = useState<AgentSession | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/runs')
      if (!res.ok) return
      setRuns(agentRunListSchema.parse(await res.json()).runs)
    } catch {
      // 폴링 실패는 다음 틱에 재시도 — 화면은 마지막 상태 유지
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const stop = useCallback(
    async (id: string) => {
      await fetch(`/api/agent/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' })
      void refresh()
    },
    [refresh]
  )

  if (runs.length === 0) {
    return <EmptyState icon={<Bot />} title={t('emptyTitle')} hint={t('emptyHint')} />
  }

  return (
    <div className="space-y-1">
      {runs.map((run) => (
        <div
          key={run.id}
          className="flex items-center gap-3 rounded-md border border-border/60 bg-card px-3 py-2 text-sm"
        >
          <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{run.origin?.agentId ?? run.title}</span>
              {run.origin?.agentVersion ? (
                <span className="text-xs text-muted-foreground">v{run.origin.agentVersion}</span>
              ) : null}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {run.origin?.eventKind
                ? t('wokeOn', { kind: run.origin.eventKind })
                : (run.origin?.type ?? '')}
              {' · '}
              {fmtTimeAgo(run.updatedAt, locale)}
            </div>
          </div>
          {run.status ? (
            <Badge tone={STATUS_TONE[run.status]}>{t(`status.${run.status}`)}</Badge>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpenRun(run)}
            aria-label={t('viewTranscript')}
          >
            <Eye className="size-4" aria-hidden />
          </Button>
          {canStop && run.status === 'running' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void stop(run.id)}
              aria-label={t('stop')}
            >
              <Square className="size-4" aria-hidden />
            </Button>
          ) : null}
        </div>
      ))}
      <RunTranscriptDialog run={openRun} onClose={() => setOpenRun(null)} />
    </div>
  )
}

// 런 트랜스크립트 드릴인 — 워크스페이스-가시 세션의 메시지를 그대로 보여준다(관측 표면, 편집 없음).
function RunTranscriptDialog({ run, onClose }: { run: AgentSession | null; onClose: () => void }) {
  const t = useTranslations('agentFleet')
  const [messages, setMessages] = useState<AgentMessage[] | null>(null)

  useEffect(() => {
    if (!run) {
      setMessages(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(run.id)}/messages`)
        if (!res.ok || cancelled) return
        setMessages(agentMessageListSchema.parse(await res.json()).messages)
      } catch {
        if (!cancelled) setMessages([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [run])

  return (
    <Dialog
      open={run !== null}
      onClose={onClose}
      className="max-h-[80vh] w-full max-w-2xl overflow-y-auto p-5"
    >
      <h2 className="mb-3 text-sm font-semibold">{run?.title}</h2>
      {messages === null ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noMessages')}</p>
      ) : (
        <div className="space-y-3">
          {messages
            .filter((m) => m.role !== 'tool')
            .map((m) => (
              <div key={m.id} className="space-y-1">
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  {m.role === 'user' ? t('roleEvent') : t('roleAgent')}
                </div>
                {m.role === 'assistant' ? (
                  <Markdown content={m.content} />
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{m.content}</p>
                )}
              </div>
            ))}
        </div>
      )}
    </Dialog>
  )
}
