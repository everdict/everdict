'use client'

import { useState } from 'react'
import Link from 'next/link'
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

// 스코어카드 결과의 톤 — 배지 색이 곧 결과다. 모르는 상태는 중립 윤곽으로 떨어진다.
const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'outline'> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'warning',
  queued: 'outline',
  superseded: 'outline',
  cancelled: 'outline',
}
const STATUS_KEYS = ['succeeded', 'failed', 'running', 'queued', 'superseded', 'cancelled']

// 데이터셋 활동 이력 — 트래커의 History 와 같은 피드 뼈대(shared/ui/activity-feed)를 쓴다:
// "이 데이터셋에 무슨 일이 있었나"가 이슈 이력과 다른 문법으로 읽히면 안 된다.
// 최근 10개만 펼치고 나머지는 "이전 이력 더 보기"로 — 논의(코멘트)는 별도 스레드다.
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
          // 워크스페이스 멤버가 아닌 주체(스케줄·에이전트)는 얼굴 대신 사건 아이콘이 노드가 된다.
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
      {/* 문장 한 덩어리 — 조각을 flex 자식으로 흩으면 조사가 앞말과 떨어진다("스코어카드 를"). */}
      <span>
        {t.rich('scorecardRan', {
          actor: item.actor.name,
          harness: item.harness,
          name: (chunks) => <span className="font-[560] text-foreground">{chunks}</span>,
          harnessLink: (chunks) => (
            <Link
              href={`/${workspace}/harnesses/${encodeURIComponent(item.harnessId)}`}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              <code className="font-mono text-foreground">{chunks}</code>
            </Link>
          ),
          cardLink: (chunks) => (
            <Link
              href={`/${workspace}/scorecards/${encodeURIComponent(item.scorecardId)}`}
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
