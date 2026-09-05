import { getTranslations } from 'next-intl/server'

import { workspacePulseSchema } from '@/entities/workspace-pulse'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'

import { PulseTiles } from './pulse-tiles'
import { PulseTrends } from './pulse-trends'

// The body of home — state and trends. It is ONE read: assembling the metrics from eight lists is eight round trips, but above all
// the arithmetic (what counts as open work, what a cycle committed, which metric represents the pass rate) is the SERVER's, and the moment the
// web re-implements it there are two answers to the same question.
export async function WorkspacePulseView({
  workspace,
  days,
}: {
  workspace: string
  days?: number
}) {
  const t = await getTranslations('overviewPage')
  const ctx = await authContext()

  let pulse
  try {
    pulse = workspacePulseSchema.parse(await controlPlane.getWorkspacePulse(ctx, days))
  } catch (e) {
    return (
      <Callout tone="danger" hint={t('connectErrorHint')}>
        {t('connectError', { error: e instanceof Error ? e.message : String(e) })}
      </Callout>
    )
  }

  return (
    <div className="space-y-7">
      <PulseTiles pulse={pulse} workspace={workspace} />
      <PulseTrends
        activity={pulse.trend.activity}
        flow={pulse.trend.flow}
        quality={pulse.trend.quality}
      />
    </div>
  )
}
