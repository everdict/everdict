import 'server-only'

import { cache } from 'react'
import { notFound } from 'next/navigation'

import { teamWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { can } from '@/shared/auth/can'
import { currentPrincipal, type WebPrincipal } from '@/shared/auth/principal'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

export interface TeamSettingsScope {
  team?: TeamWithSummary
  principal: WebPrincipal | null
  ctx: AuthContext
  canRead: boolean
  canWrite: boolean
  error?: string
}

// 팀 설정 탭들이 공유하는 한 번의 읽기 — 레이아웃(머리글·탭)과 그 아래 탭이 같은 팀을 그리므로, `cache()` 로
// 요청당 한 번만 제어 평면에 묻는다. 탭 라우트의 규칙이다: 팬아웃되는 상세 읽기가 한 화면에 두 번 돌면 안 된다.
//
// 다른 워크스페이스의 팀은 404 로 읽힌다(존재 여부를 흘리지 않는다) — 그래서 여기서 바로 notFound() 다.
export const loadTeamSettings = cache(async (key: string): Promise<TeamSettingsScope> => {
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'teams:read')
  const canWrite = can(principal?.roles, 'teams:write')
  if (!principal || !canRead) return { principal, ctx, canRead: false, canWrite: false }
  try {
    const team = teamWithSummarySchema.parse(
      await controlPlane.getTeam(ctx, decodeURIComponent(key))
    )
    return { team, principal, ctx, canRead, canWrite }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes('404') || message.toLowerCase().includes('not found')) notFound()
    return { principal, ctx, canRead, canWrite, error: message }
  }
})
