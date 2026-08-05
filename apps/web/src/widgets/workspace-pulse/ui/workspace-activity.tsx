import { History } from 'lucide-react'
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server'

import { memberDirectoryOf, membersSchema } from '@/entities/member'
import { platformEventListSchema } from '@/entities/platform-event'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { ActivityFeed } from '@/shared/ui/activity-feed'
import { EmptyState } from '@/shared/ui/empty-state'
import { SectionHeader } from '@/shared/ui/section-header'

import { ActivityEventRow } from './activity-event-row'

// 활동 — 이 워크스페이스에 실제로 기록된 사실들. 평가만이 아니라 이슈·사이클·목표·에이전트·파일·지식까지
// 한 줄기로 흐른다. 홈이 "평가 전용 화면"으로 읽히던 이유의 절반이 이 피드가 없었다는 것이다.
// 줄 하나가 어떻게 읽히는가(누가 · 무엇을 · 어떻게 됐다)는 `activity-event-row` 가 정한다.
const FEED_LIMIT = 14

export async function WorkspaceActivity({ workspace }: { workspace: string }) {
  const t = await getTranslations('overviewPage')
  const locale = await getLocale()
  const timeZone = await getTimeZone()
  const ctx = await authContext()

  // 이벤트 로그가 없는 배포도 있다(그리고 events:read 가 없는 역할도) — 피드가 없다고 홈이 깨지지는 않는다.
  const [events, members] = await Promise.all([
    controlPlane
      .listPlatformEvents(ctx, FEED_LIMIT)
      .then((r) => platformEventListSchema.parse(r).events)
      .catch(() => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => []),
  ])
  const directory = memberDirectoryOf(members)

  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('activityTitle')} />
      {events.length === 0 ? (
        <EmptyState
          icon={<History />}
          title={t('activityEmptyTitle')}
          hint={t('activityEmptyHint')}
        />
      ) : (
        <div className="rounded-lg border bg-card p-3.5 shadow-raise">
          <ActivityFeed>
            {events.map((event) => (
              <ActivityEventRow
                key={event.id}
                event={event}
                workspace={workspace}
                directory={directory}
                locale={locale}
                timeZone={timeZone}
              />
            ))}
          </ActivityFeed>
        </div>
      )}
    </section>
  )
}
