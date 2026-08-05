import { getTranslations } from 'next-intl/server'

import { workspacePulseSchema } from '@/entities/workspace-pulse'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'

import { PulseTiles } from './pulse-tiles'
import { PulseTrends } from './pulse-trends'

// 홈의 본문 — 현황과 추이. 한 번의 읽기다: 지표를 목록 여덟 개에서 조립하면 왕복도 여덟 번이지만, 무엇보다
// 그 산식(무엇이 열린 일인가, 사이클이 커밋한 것은 무엇인가, 통과율은 어떤 지표를 대표로 삼는가)이 서버
// 것이라 웹이 다시 구현하는 순간 같은 질문에 두 개의 답이 생긴다.
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
