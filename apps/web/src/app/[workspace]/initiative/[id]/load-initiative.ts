import { cache } from 'react'

import {
  initiativeDetailSchema,
  initiativesSchema,
  type Initiative,
  type InitiativeDetail,
} from '@/entities/initiative'
import { membersSchema, type Member } from '@/entities/member'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 상세는 탭 셋이 한 레이아웃(헤더·속성 열)을 공유하고, 레이아웃과 그 안의 탭이 **같은** 읽기를 필요로 한다.
// React 의 `cache` 로 한 요청 안에서 한 번만 부르게 묶어 두는 이유가 이것이다 — 목표 상세는 프로젝트마다
// 이슈를 훑는 팬아웃이라, 레이아웃과 페이지가 각자 부르면 한 화면에 두 번 돈다. 인자는 문자열 하나뿐이라
// 캐시 키가 참조 동일성에 걸리지 않는다.

export interface InitiativeLoad {
  initiative: InitiativeDetail | undefined
  error: string | undefined
  roles: string[]
  // 다른 이니셔티브들 — 상위/하위 관계를 그리고, 편집 다이얼로그의 상위 후보가 된다.
  initiatives: Initiative[]
  members: Member[]
}

export const loadInitiative = cache(async (id: string): Promise<InitiativeLoad> => {
  const { principal, ctx } = await currentPrincipal()
  let initiative: InitiativeDetail | undefined
  let error: string | undefined
  try {
    initiative = initiativeDetailSchema.parse(await controlPlane.getInitiative(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  // 보조 읽기 — 하나가 실패해도 상세는 계속 그려진다(그 칸만 비어 있게 된다).
  const [initiatives, members] = await Promise.all([
    controlPlane
      .listInitiatives(ctx)
      .then((r) => initiativesSchema.parse(r))
      .catch((): Initiative[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch((): Member[] => []),
  ])
  return {
    initiative,
    error,
    roles: principal?.roles ?? [],
    initiatives,
    members,
  }
})
