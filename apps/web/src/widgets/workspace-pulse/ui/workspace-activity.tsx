import { History } from 'lucide-react'
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server'

import { memberDirectoryOf, membersSchema } from '@/entities/member'
import { platformEventListSchema } from '@/entities/platform-event'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { ActivityFeed } from '@/shared/ui/activity-feed'
import { EmptyState } from '@/shared/ui/empty-state'
import { SectionHeader } from '@/shared/ui/section-header'

import { collapseActivityBursts } from '../model/activity-burst'
import { ActivityEventRow } from './activity-event-row'

// Activity — the facts actually recorded in this workspace. Not evaluation alone: issues, cycles, goals, agents, files and knowledge all flow
// in one stream. Half the reason home read as an "evaluation-only screen" was that this feed did not exist.
// How one row reads (who · what · what happened) is decided by `activity-event-row`.
//
// It reads generously (FETCH_LIMIT), folds consecutive same-kind events by the same actor into one row, and then draws FEED_LIMIT rows —
// drawing "the newest 14" raw means the moment an agent publishes a dozen files in one turn the whole feed is eaten by that one actor, and
// this feed's reason for existing, the activity of everyone in the workspace, is gone.
const FETCH_LIMIT = 120
const FEED_LIMIT = 14

export async function WorkspaceActivity({ workspace }: { workspace: string }) {
  const t = await getTranslations('overviewPage')
  const locale = await getLocale()
  const timeZone = await getTimeZone()
  const ctx = await authContext()

  // Some deployments have no event log (and some roles no events:read) — home does not break for the lack of a feed.
  const [events, members] = await Promise.all([
    controlPlane
      .listPlatformEvents(ctx, FETCH_LIMIT)
      .then((r) => platformEventListSchema.parse(r).events)
      .catch(() => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => []),
  ])
  const directory = memberDirectoryOf(members)
  const bursts = collapseActivityBursts(events).slice(0, FEED_LIMIT)

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
            {bursts.map(({ event, more }) => (
              <ActivityEventRow
                key={event.id}
                event={event}
                more={more}
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
