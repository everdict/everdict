'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 능력·증거를 다른 팀 앞으로 다시 세우는 변이. 자원 종류마다 경로만 다르고 행위는 하나라서 액션도 하나다 —
// 종류별 사본은 네 벌이 서로 다른 말을 하게 되는 길이다.
//
// 화면 갱신은 부른 쪽의 `refresh()` 가 한다. 여기서 `revalidatePath` 를 부르면 안 된다: 무효화할
// 캐시가 없는데도 Next 16 은 선언 자체로 클라이언트 prefetch 캐시를 통째로 버린다(features/manage-issue 참조).
export type MoveToTeamKind =
  | 'harnesses'
  | 'harness-templates'
  | 'datasets'
  | 'judges'
  | 'scorecards'

export interface MoveToTeamResult {
  ok: boolean
  teamId?: string
  error?: string
}

export async function moveToTeamAction(
  kind: MoveToTeamKind,
  id: string,
  teamId: string
): Promise<MoveToTeamResult> {
  const ctx = await authContext()
  try {
    const moved = await controlPlane.moveCapabilityTeam<{ teamId?: string }>(ctx, kind, id, teamId)
    return { ok: true, ...(moved?.teamId !== undefined ? { teamId: moved.teamId } : {}) }
  } catch (e) {
    // 두 팀 중 하나에 속하지 않으면 403, 없는 팀·워크스페이스 것이 아닌 자원은 404, 이미 그 팀이면 409 —
    // 어느 쪽이든 제어 평면의 말을 그대로 보여준다(화면이 다음 수를 지어내지 않는다).
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
