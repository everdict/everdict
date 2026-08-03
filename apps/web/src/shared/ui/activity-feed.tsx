import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'

// Linear st. 활동 피드 — "누가 · 무엇을 했다 · 언제"를 한 줄로 읽히게 하는 공용 뼈대.
// 이력을 보여주는 화면(이슈·프로젝트·이니셔티브의 History, 데이터셋의 Activity)은 전부 이 한 벌을 쓴다:
// 화면마다 `event · name · date` 를 다시 조립하면 같은 사건이 화면마다 다르게 읽히기 때문이다.
// 이 아톰은 훅을 쓰지 않는다(서버·클라이언트 양쪽에서 그대로 렌더된다) — 로케일/타임존은 호출부가 넘긴다.
export type ActivityTone = 'neutral' | 'success' | 'danger' | 'warning' | 'info'

// 노드 배지의 아이콘 색 — 사건의 성격(성공·경보·진행)을 한 눈에 구분하는 유일한 색 신호다.
const TONE_TEXT: Record<ActivityTone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-[var(--color-success)]',
  danger: 'text-destructive',
  warning: 'text-[var(--color-warning)]',
  info: 'text-[var(--color-link)]',
}

export interface ActivityActor {
  name: string
  avatarUrl?: string
}

export function ActivityFeed({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn('space-y-0', className)}>{children}</ol>
}

// 한 줄 = 노드(행위자 얼굴 + 사건 아이콘 배지) · 문장 · 값 칩 · 상대 시각.
// 행위자를 아는 경우 얼굴이 노드가 되고 사건 아이콘은 오른쪽 아래 배지로 붙는다(사람의 행동).
// 모르는 주체(GitHub 동기화·회귀 감시 같은 시스템)는 얼굴 대신 사건 아이콘 자체가 노드가 된다.
// 노드 사이를 잇는 세로선은 두지 않는다 — 줄마다 얼굴이 서면 선까지 그리는 순간 장식이 내용을 이긴다.
export function ActivityRow({
  actor,
  icon: Icon,
  tone = 'neutral',
  at,
  locale,
  timeZone,
  children,
}: {
  actor?: ActivityActor
  icon: LucideIcon
  tone?: ActivityTone
  at: string
  locale: string
  timeZone?: string
  children: ReactNode
}) {
  return (
    <li className="flex gap-2.5 pb-3.5 last:pb-0">
      <span className="relative shrink-0">
        {actor ? (
          <>
            <Avatar
              name={actor.name}
              {...(actor.avatarUrl !== undefined ? { url: actor.avatarUrl } : {})}
              size="md"
              className="rounded-full"
            />
            <span
              className={cn(
                'absolute -bottom-1 -right-1 grid size-3.5 place-items-center rounded-full bg-background ring-2 ring-background',
                TONE_TEXT[tone]
              )}
            >
              <Icon className="size-3" strokeWidth={2.25} />
            </span>
          </>
        ) : (
          <span
            className={cn(
              'grid size-6 place-items-center rounded-full bg-secondary ring-1 ring-inset ring-border',
              TONE_TEXT[tone]
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.75} />
          </span>
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 pt-0.5 text-[12.5px] leading-tight text-muted-foreground">
        {children}
        <ActivityTime at={at} locale={locale} timeZone={timeZone} />
      </div>
    </li>
  )
}

// 행위자 이름 — 문장의 주어. 이름만 진하게 두고 서술어는 muted 로 남겨 훑을 때 사람이 먼저 보인다.
export function ActivityActorName({ name }: { name: string }) {
  return <span className="font-[560] text-foreground">{name}</span>
}

// 상대 시각(호버 시 절대 시각). 문장 끝에 붙어 줄바꿈을 자연스럽게 따라간다.
export function ActivityTime({
  at,
  locale,
  timeZone,
}: {
  at: string
  locale: string
  timeZone?: string
}) {
  return (
    <time
      dateTime={at}
      className="shrink-0 text-[11px] text-faint"
      title={fmtDateTimeFull(at, { locale, ...(timeZone !== undefined ? { timeZone } : {}) })}
    >
      {fmtTimeAgo(at, locale, timeZone)}
    </time>
  )
}
