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

// The updates tab — the only **judgement** standing beside the arithmetic. The server counts the progress, but "so is it all right" is what a
// PERSON says, and the reason a colour changed lives only in that sentence. Newest first (the server order verbatim) because what someone
// coming to this screen asks is "how is it now".
export default async function InitiativeUpdatesPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { id } = await params
  const t = await getTranslations('initiativesPage')
  const timeZone = await getTimeZone()
  const { initiative, roles, members } = await loadInitiative(id)
  if (!initiative) return null // the layout already drew the failure

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
