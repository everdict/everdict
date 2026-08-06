'use client'

import { useEffect, useState } from 'react'
import { Check, ChevronDown, Timer } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { Run } from '@/entities/run'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { StatusPill } from '@/shared/ui/status-pill'
import { Tooltip } from '@/shared/ui/tooltip'

import { fmtCountdown } from '../lib/merge'

// What the member is holding open: which harness booted, in which image, how long it has left and how to end it.
// A session's disposal is the invariant, so the TTL is not decoration — it is the deadline the control-plane
// reaper enforces. The countdown ticks locally (1s) off the record's expiresAt and re-derives whenever the poll
// brings a fresher record, so a touch/extension corrects it without a second clock.
export function SessionHeader({
  record,
  harness,
  conversation = false,
  sessions = [],
  onSwitch,
  closed,
  closing,
  onClose,
}: {
  record: Run
  harness?: { id: string; version: string; kind?: string }
  conversation?: boolean
  // Every live session on the control plane. More than one means the member is holding several harnesses open
  // at once, so the badge becomes a picker; a single session keeps a plain badge (no dropdown for one choice).
  sessions?: { id: string; label: string }[]
  onSwitch?: (id: string) => void
  closed: boolean
  closing: boolean
  onClose: () => void
}) {
  const t = useTranslations('playground')
  const expiresAt = record.session?.expiresAt
  const [remainingMs, setRemainingMs] = useState(() =>
    expiresAt === undefined ? 0 : Date.parse(expiresAt) - Date.now()
  )

  useEffect(() => {
    if (expiresAt === undefined) return
    const deadline = Date.parse(expiresAt)
    const tick = () => setRemainingMs(deadline - Date.now())
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  const label = harness ?? record.harness
  const reason = record.session?.closedReason

  return (
    <div className="space-y-1.5 border-b border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        {sessions.length > 1 && onSwitch ? (
          <DropdownMenu
            align="start"
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-label={t('switchSession')}
                className="flex min-w-0 items-center gap-1"
              >
                <Badge tone="info" className="font-mono">
                  {label.id}
                  <span className="opacity-60">@{label.version}</span>
                  <ChevronDown className="size-3 opacity-70" />
                </Badge>
              </button>
            )}
          >
            {sessions.map((session) => (
              <DropdownItem
                key={session.id}
                onSelect={() => onSwitch(session.id)}
                trailing={session.id === record.id ? <Check className="size-3.5" /> : undefined}
                className="font-mono text-[12px]"
              >
                {session.label}
              </DropdownItem>
            ))}
          </DropdownMenu>
        ) : (
          <Badge tone="info" className="font-mono">
            {label.id}
            <span className="opacity-60">@{label.version}</span>
          </Badge>
        )}
        {conversation && <Badge tone="outline">{t('conversationBadge')}</Badge>}
        <StatusPill status={record.status} />
        <div className="flex-1" />
        {!closed && (
          <Button variant="ghost" size="xs" onClick={onClose} disabled={closing}>
            {closing ? t('closing') : t('close')}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {record.session !== undefined && (
          <Tooltip content={t('sessionImage')}>
            <span className="min-w-0 truncate font-mono text-[10.5px]">{record.session.image}</span>
          </Tooltip>
        )}
        {record.runtime !== undefined && (
          <Tooltip content={t('sessionRuntime')}>
            <span className="shrink-0 font-mono text-[10.5px]">{record.runtime}</span>
          </Tooltip>
        )}
        <div className="flex-1" />
        {closed ? (
          <span>{reason === undefined ? t('closed') : t(`closedReason_${reason}`)}</span>
        ) : (
          expiresAt !== undefined && (
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              <Timer className="size-3" />
              {t('expiresIn', { time: fmtCountdown(remainingMs) })}
            </span>
          )
        )}
      </div>
    </div>
  )
}
