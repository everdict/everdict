import { Megaphone } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { InitiativeUpdatePanel } from '@/features/manage-initiative'
import { initiativeUpdatesSchema, type InitiativeUpdate } from '@/entities/initiative'
import { memberDirectoryOf, memberNameOf } from '@/entities/member'
import { HealthBadge } from '@/entities/tracker-health'
import { can } from '@/shared/auth/can'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/empty-state'

import { loadInitiative } from '../load-initiative'

export const dynamic = 'force-dynamic'

// 업데이트 탭 — 산수 옆에 있는 유일한 **판단**. 진척은 서버가 세지만 "그래서 괜찮은가"는 사람이 말하는
// 것이고, 색이 바뀐 이유는 그 문장에만 있다. 최신이 위(서버 정렬 그대로)인 이유는 이 화면에 오는 사람이
// 묻는 게 "지금 어떤가"이기 때문이다.
export default async function InitiativeUpdatesPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { id } = await params
  const t = await getTranslations('initiativesPage')
  const timeZone = await getTimeZone()
  const { initiative, roles, members } = await loadInitiative(id)
  if (!initiative) return null // 레이아웃이 이미 실패를 그렸다

  const ctx = await authContext()
  const updates = await controlPlane
    .listInitiativeUpdates(ctx, id)
    .then((r) => initiativeUpdatesSchema.parse(r))
    .catch((): InitiativeUpdate[] => [])

  const canWrite = can(roles, 'issues:write')
  const actors = memberDirectoryOf(members)

  return (
    <div className="space-y-4">
      {canWrite && <InitiativeUpdatePanel id={initiative.id} />}
      {updates.length === 0 ? (
        <EmptyState
          icon={<Megaphone strokeWidth={1.75} />}
          title={t('updatesEmptyTitle')}
          hint={t('updatesEmptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {updates.map((update) => (
            <article key={update.id} className="rounded-lg border bg-card p-3 shadow-raise">
              <div className="flex flex-wrap items-center gap-2">
                <HealthBadge health={update.health} />
                <span className="text-[12px] text-muted-foreground">
                  {memberNameOf(actors, update.createdBy)}
                </span>
                <time
                  className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground"
                  dateTime={update.createdAt}
                  title={fmtDateTimeFull(update.createdAt, { timeZone })}
                >
                  {fmtDateTime(update.createdAt, timeZone)}
                </time>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                {update.body}
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
