'use client'

import { useState } from 'react'
import { Bot, Check, Eye, Plus, Trash2, Users, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  AGENT_EVENT_KINDS,
  type AgentEventKind,
  type AgentTeammate,
} from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

// 대화창 헤더의 "팀" 버튼 → 플로팅 드롭다운. 사용자가 스폰한 장수 자율 에이전트(teammate) 목록을 보여주고,
// 새 teammate 스폰(이름 + 상시 작업 지시 + 구독할 이벤트 종류)과 중지를 페이지 전환 없이 메뉴 안에서 처리한다.
// teammate 는 구독한 이벤트(run/scorecard 완료 등)가 오면 스스로 깨어나 반응한다(proactive team, S4/S5).

function kindLabel(t: ReturnType<typeof useTranslations>, kind: string): string {
  // Known kinds get a friendly label; an unknown kind (future server-side) falls back to its raw id.
  return (AGENT_EVENT_KINDS as readonly string[]).includes(kind) ? t(`kind.${kind}`) : kind
}

function SpawnForm({ onSpawn }: { onSpawn: (input: TeammateSpawnInput) => void }) {
  const t = useTranslations('agentChat.team')
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [watch, setWatch] = useState<AgentEventKind[]>([])

  const canSubmit = name.trim().length > 0 && task.trim().length > 0
  const toggle = (k: AgentEventKind) =>
    setWatch((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))

  const submit = () => {
    if (!canSubmit) return
    onSpawn({ name: name.trim(), task: task.trim(), watch })
    setName('')
    setTask('')
    setWatch([])
  }

  return (
    <div className="space-y-2 px-2 pb-2 pt-1">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('namePlaceholder')}
        maxLength={60}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-primary/50"
      />
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder={t('taskPlaceholder')}
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] leading-relaxed outline-none focus:border-primary/50"
      />
      <div>
        <p className="mb-1 flex items-center gap-1 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
          <Eye className="size-3" strokeWidth={2} />
          {t('watchLabel')}
        </p>
        <div className="flex flex-wrap gap-1">
          {AGENT_EVENT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                watch.includes(k)
                  ? 'border-primary/50 bg-primary/12 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
              )}
            >
              {kindLabel(t, k)}
            </button>
          ))}
        </div>
      </div>
      <Button size="sm" className="w-full" disabled={!canSubmit} onClick={submit}>
        <Plus className="size-3.5" />
        {t('spawn')}
      </Button>
    </div>
  )
}

function TeammateRow({
  teammate,
  onStop,
}: {
  teammate: AgentTeammate
  onStop: (id: string) => void
}) {
  const t = useTranslations('agentChat.team')
  const [pendingStop, setPendingStop] = useState(false)

  return (
    <li className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent">
      <Bot className="mt-0.5 size-4 shrink-0 text-primary/70" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-[510] text-foreground">{teammate.name}</p>
        {teammate.watch.length > 0 ? (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {teammate.watch.map((k) => (
              <span
                key={k}
                className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
              >
                {kindLabel(t, k)}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-0.5 text-[10.5px] text-faint">{t('watchesNothing')}</p>
        )}
      </div>
      {pendingStop ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('confirmStop')}
            onClick={() => {
              setPendingStop(false)
              onStop(teammate.id)
            }}
            className="size-6 text-destructive hover:text-destructive"
          >
            <Check className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('cancel')}
            onClick={() => setPendingStop(false)}
            className="size-6"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('stop')}
          onClick={() => setPendingStop(true)}
          className="size-6 shrink-0 opacity-0 hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </li>
  )
}

export interface TeammateSpawnInput {
  name: string
  task: string
  watch: AgentEventKind[]
}

export function TeamMenu({
  teammates,
  onSpawn,
  onStop,
}: {
  teammates: AgentTeammate[]
  onSpawn: (input: TeammateSpawnInput) => void
  onStop: (id: string) => void
}) {
  const t = useTranslations('agentChat.team')
  const [spawning, setSpawning] = useState(false)

  return (
    <DropdownMenu
      align="end"
      contentClassName="w-80"
      trigger={({ toggle, open }) => (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('title')}
          aria-expanded={open}
          onClick={toggle}
          className="relative"
        >
          <Users />
          {teammates.length > 0 && (
            <span className="-right-0.5 -top-0.5 absolute grid size-3.5 place-items-center rounded-full bg-primary text-[9px] font-[560] text-primary-foreground tabular-nums">
              {teammates.length}
            </span>
          )}
        </Button>
      )}
    >
      <div className="flex items-center justify-between pr-1">
        <DropdownLabel>{t('title')}</DropdownLabel>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('spawn')}
          onClick={() => setSpawning((v) => !v)}
          className={cn('size-6', spawning && 'text-primary')}
        >
          {spawning ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
        </Button>
      </div>
      {spawning && (
        <SpawnForm
          onSpawn={(input) => {
            onSpawn(input)
            setSpawning(false)
          }}
        />
      )}
      <div className="max-h-[min(320px,45vh)] overflow-y-auto">
        {teammates.length === 0 ? (
          <p className="px-2 pb-2 pt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {teammates.map((tm) => (
              <TeammateRow key={tm.id} teammate={tm} onStop={onStop} />
            ))}
          </ul>
        )}
      </div>
    </DropdownMenu>
  )
}
