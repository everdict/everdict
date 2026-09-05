'use client'

import { useState } from 'react'
import { BarChart3, History, Sparkles, type LucideIcon } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import {
  ActivityActorName,
  ActivityFeed,
  ActivityRow,
  type ActivityActor,
  type ActivityTone,
} from '@/shared/ui/activity-feed'
import { Badge } from '@/shared/ui/badge'
import { Link } from '@/shared/ui/link'

export interface Actor {
  name: string
  avatarUrl?: string
  known: boolean
}
// Dataset activity events (comments are a separate CommentThread) — creation + scorecard runs.
export type ActivityItem =
  | { kind: 'created'; at: string; actor: Actor }
  | {
      kind: 'scorecard'
      at: string
      actor: Actor
      scorecardId: string
      harnessId: string
      harness: string
      status: string
      passRate: number | null
    }

const INITIAL = 10
const STEP = 20

// The tone of a scorecard result — the badge colour IS the result. An unknown status falls back to a neutral outline.
const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'outline'> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'warning',
  queued: 'outline',
  superseded: 'outline',
  cancelled: 'outline',
}
const STATUS_KEYS = ['succeeded', 'failed', 'running', 'queued', 'superseded', 'cancelled']

// The dataset activity history — it uses the same feed skeleton as the tracker's History (shared/ui/activity-feed):
// "what happened to this dataset" must not read in a different grammar from an issue's history.
// Only the newest ten are expanded and the rest arrive through "show earlier history" — discussion (comments) is a separate thread.
export function ActivityTimeline({
  workspace,
  items,
}: {
  workspace: string
  items: ActivityItem[]
}) {
  const t = useTranslations('discussDataset')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [shown, setShown] = useState(INITIAL)
  const start = Math.max(0, items.length - shown)
  const visible = items.slice(start)
  const hidden = start

  return (
    <div className="space-y-3">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShown((s) => s + STEP)}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[12px] font-[510] text-muted-foreground shadow-raise transition-colors hover:border-border-strong hover:text-foreground"
        >
          <History className="size-3.5" />
          {t('showPrevious', { count: hidden })}
        </button>
      )}
      <ActivityFeed>
        {visible.map((item, i) => {
          const { icon, tone } = shapeOf(item)
          // A subject that is not a workspace member (a schedule, an agent) gets the event icon as the node instead of a face.
          const actor: ActivityActor | undefined = item.actor.known
            ? {
                name: item.actor.name,
                ...(item.actor.avatarUrl !== undefined ? { avatarUrl: item.actor.avatarUrl } : {}),
              }
            : undefined
          return (
            <ActivityRow
              key={`${item.kind}-${start + i}`}
              actor={actor}
              icon={icon}
              tone={tone}
              at={item.at}
              locale={locale}
              timeZone={timeZone}
            >
              <EventText workspace={workspace} item={item} />
            </ActivityRow>
          )
        })}
      </ActivityFeed>
    </div>
  )
}

function shapeOf(item: ActivityItem): { icon: LucideIcon; tone: ActivityTone } {
  if (item.kind === 'created') return { icon: Sparkles, tone: 'neutral' }
  const tone = STATUS_TONE[item.status]
  return {
    icon: BarChart3,
    tone: tone === 'success' || tone === 'danger' || tone === 'warning' ? tone : 'neutral',
  }
}

function EventText({ workspace, item }: { workspace: string; item: ActivityItem }) {
  const t = useTranslations('discussDataset')
  if (item.kind === 'created') {
    return (
      <>
        <ActivityActorName name={item.actor.name} />
        <span>{t('createdSuffix')}</span>
      </>
    )
  }
  const tone = STATUS_TONE[item.status] ?? 'outline'
  const statusLabel = STATUS_KEYS.includes(item.status) ? t(`status.${item.status}`) : item.status
  return (
    <>
      {/* The sentence as ONE block — scattering the fragments as flex children separates a Korean particle from the word it attaches to. */}
      <span>
        {t.rich('scorecardRan', {
          actor: item.actor.name,
          harness: item.harness,
          name: (chunks) => <span className="font-[560] text-foreground">{chunks}</span>,
          harnessLink: (chunks) => (
            <Link
              href={`/${workspace}/harness/${encodeURIComponent(item.harnessId)}`}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              <code className="font-mono text-foreground">{chunks}</code>
            </Link>
          ),
          cardLink: (chunks) => (
            <Link
              href={`/${workspace}/scorecard/${encodeURIComponent(item.scorecardId)}`}
              className="font-[510] text-foreground underline-offset-2 hover:text-primary hover:underline"
            >
              {chunks}
            </Link>
          ),
        })}
      </span>
      <Badge tone={tone}>{statusLabel}</Badge>
      {item.passRate != null && (
        <span className="tabular-nums text-[11px] text-faint">
          {t('passRate', { pct: Math.round(item.passRate * 100) })}
        </span>
      )}
    </>
  )
}
