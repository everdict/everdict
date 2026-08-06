'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// ⚠️ 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데 Next 16 은 선언만으로 prefetch 캐시를 통째로 버려 화면의 모든 `<Link>` 가
// 다시 prefetch 되고, 변이의 트랜지션이 그 큐에 묶인다). 근거는 `docs/web.md`.
// 팀 변경은 사이드바(팀 목록)에도 나타나는데, `refresh()` 는 레이아웃까지 다시 그리므로 그쪽도 따라온다.

export interface TeamMutationResult {
  ok: boolean
  error?: string
  id?: string
}

async function mutate<T>(run: () => Promise<T>): Promise<TeamMutationResult> {
  try {
    const result = await run()
    const id = (result as { id?: unknown } | undefined)?.id
    return { ok: true, ...(typeof id === 'string' ? { id } : {}) }
  } catch (e) {
    // 키 중복(409)·형식 오류(400)·권한(403)은 전부 컨트롤 플레인이 판정한다 — 여기서 다시 판단하지 않는다.
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function createTeamAction(input: {
  key: string
  name: string
  description?: string
  isDefault?: boolean
  isPrivate?: boolean
  // 상위 팀 — 조직 표현일 뿐이다. 하위 팀도 자기 이슈를 소유하고 자기 식별자를 발번한다.
  parentId?: string
}): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.createTeam<{ id: string }>(ctx, input))
}

export async function updateTeamAction(
  id: string,
  // null 은 상위에서 떼어내 최상위 팀으로 되돌린다. 자기 하위로 옮기는 시도는 서버가 409로 거절한다.
  patch: {
    name?: string
    description?: string | null
    parentId?: string | null
    // 팀이 스스로를 재는 리듬. 켜는 순간부터 사이클 목록 읽기가 파이프라인을 세운다.
    cyclesEnabled?: boolean
    cycleDurationWeeks?: number
    cycleStartDay?: number
    upcomingCycleCount?: number
    cycleAutoClose?: boolean
    triageEnabled?: boolean
    isPrivate?: boolean
  }
): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.updateTeam(ctx, id, patch))
}

// 기본팀 이양 — 컨트롤 플레인이 기존 기본팀을 강등하고 이 팀을 승격한다(워크스페이스에 기본팀이 없는 순간이 없다).
export async function setDefaultTeamAction(id: string): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.setDefaultTeam(ctx, id))
}

// 기본팀·마지막 팀·이슈를 든 팀은 서버가 409로 거절한다(개수를 메시지에 담아서).
export async function deleteTeamAction(id: string): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.deleteTeam(ctx, id))
}

export async function addTeamMemberAction(
  id: string,
  subject: string
): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.addTeamMember(ctx, id, subject))
}

export async function removeTeamMemberAction(
  id: string,
  subject: string
): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.removeTeamMember(ctx, id, subject))
}

// 셀프 서비스 — 자기 자신을 넣고 뺀다(teams:join, member+). 관리자의 로스터 관리(add/remove)와 달리
// 대상 subject 가 없다: 컨트롤 플레인이 호출자 본인만 움직인다.
export async function joinTeamAction(id: string): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.joinTeam(ctx, id))
}

export async function leaveTeamAction(id: string): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.leaveTeam(ctx, id))
}

// --- 팀의 보드(워크플로 상태) ---------------------------------------------------------------------------
// 이름·색·순서를 바꾸는 것은 화장이고, `status` 를 바꾸는 것은 그 컬럼에 있던 이슈들을 실제로 옮긴다(서버가
// 같은 동작에서 한다). 컬럼을 지우려면 먼저 비워야 한다.

export async function createWorkflowStateAction(
  teamId: string,
  input: { name: string; status: string; color: string }
): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.createWorkflowState<{ id: string }>(ctx, teamId, input))
}

export async function updateWorkflowStateAction(
  teamId: string,
  stateId: string,
  patch: { name?: string; color?: string; position?: number; status?: string }
): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.updateWorkflowState(ctx, teamId, stateId, patch))
}

export async function deleteWorkflowStateAction(
  teamId: string,
  stateId: string
): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.deleteWorkflowState(ctx, teamId, stateId))
}
