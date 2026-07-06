import 'server-only'

import { membersSchema } from '@/entities/member'
import { scorecardsSchema, type ScorecardRecord } from '@/entities/scorecard'
import { viewsSchema, type View } from '@/entities/view'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export type Author = { name: string; avatarUrl?: string }

export interface AnalysisData {
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  savedViews: View[]
  subject: string
  canManage: boolean // scorecards:run — View 저장·수정·삭제(소유) 가능
  isAdmin: boolean // 워크스페이스 admin — 남의 공유 View 도 관리 가능(컨트롤플레인이 최종 강제)
  error?: string
}

// 분석/뷰 화면들이 공유하는 서버 로더 — 스코어카드 + 실행자 이름 + 저장된 View + 현재 신원/권한을 한 번에.
// 스코어카드 목록은 요약(summary)만 실려 가벼움. 부가 데이터(members/views)는 실패해도 화면은 뜬다.
export async function loadAnalysisData(): Promise<AnalysisData> {
  const { ctx, principal } = await currentPrincipal()

  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const savedViews = await controlPlane
    .listViews(ctx)
    .then((r) => viewsSchema.parse(r))
    .catch(() => [])

  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, Author> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  return {
    scorecards,
    authors,
    savedViews,
    subject: principal?.subject ?? '',
    canManage: can(principal?.roles, 'scorecards:run'),
    isAdmin: principal?.roles.includes('admin') ?? false,
    ...(error ? { error } : {}),
  }
}
