'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface TeamMutationResult {
  ok: boolean
  error?: string
  id?: string
}

// 팀 변경은 사이드바(팀 목록)와 설정 화면 양쪽에 나타나므로 워크스페이스 루트까지 무효화한다.
function revalidateTeamSurfaces(): void {
  revalidatePath('/[workspace]', 'layout')
}

async function mutate<T>(run: () => Promise<T>): Promise<TeamMutationResult> {
  try {
    const result = await run()
    revalidateTeamSurfaces()
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
}): Promise<TeamMutationResult> {
  const ctx = await authContext()
  return mutate(() => controlPlane.createTeam<{ id: string }>(ctx, input))
}

export async function updateTeamAction(
  id: string,
  patch: { name?: string; description?: string | null }
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

export async function addTeamMemberAction(id: string, subject: string): Promise<TeamMutationResult> {
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
