'use server'

import { z } from 'zod'

import { projectSchema, type Project, type ProjectStatus } from '@/entities/project'
import type { TrackerHealth } from '@/entities/tracker-health'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Tracker project server actions. The one interesting operation is completion: it is a GATE, refused with a
// 409 while the project has open issues. `force` is the deliberate override (a release ships with known gaps)
// and is recorded on the fact, so the history says the deadline was overridden rather than met.
//
// ⚠️ 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데 Next 16 은 선언만으로 prefetch 캐시를 통째로 버려 화면의 모든 `<Link>` 가
// 다시 prefetch 되고, 변이의 트랜지션이 그 큐에 묶인다). 근거는 `docs/web.md`.

export interface ProjectActionResult {
  ok: boolean
  project?: Project
  error?: string
  // Set when the completion gate refused — the count of issues still open. The UI asks for an explicit
  // "complete anyway"; nothing here retries with force on its own.
  blockedBy?: number
}

// The 409's payload as the domain shapes it. Parsed defensively: a refusal without a count is still a refusal.
const gatePayloadSchema = z.object({ openIssues: z.number() })
const errorEnvelopeSchema = z.object({
  message: z.string().optional(),
  data: z.unknown().optional(),
})

export async function createProjectAction(input: {
  name: string
  description?: string
  teamIds?: string[]
  initiativeIds?: string[]
  targetDate?: string
}): Promise<ProjectActionResult> {
  const ctx = await authContext()
  try {
    const project = projectSchema.parse(await controlPlane.createProject(ctx, input))
    return { ok: true, project }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function updateProjectAction(
  id: string,
  patch: {
    name?: string
    description?: string | null
    // 목록은 통째로 대체된다 — 빈 배열이 "전부 떼기"를 표현하는 유일한 방법이다.
    teamIds?: string[]
    initiativeIds?: string[]
    targetDate?: string | null
  }
): Promise<ProjectActionResult> {
  const ctx = await authContext()
  try {
    const project = projectSchema.parse(await controlPlane.updateProject(ctx, id, patch))
    return { ok: true, project }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setProjectStatusAction(
  id: string,
  status: ProjectStatus,
  force?: boolean
): Promise<ProjectActionResult> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.setProjectStatus(ctx, id, {
      status,
      ...(force ? { force: true } : {}),
    })
    if (res.ok) {
      const project = projectSchema.parse(res.body)
      return { ok: true, project }
    }
    const envelope = errorEnvelopeSchema.safeParse(res.body)
    const message = envelope.success ? envelope.data.message : undefined
    const gate = envelope.success ? gatePayloadSchema.safeParse(envelope.data.data) : undefined
    return {
      ok: false,
      ...(message ? { error: message } : {}),
      ...(res.status === 409 && gate?.success ? { blockedBy: gate.data.openIssues } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 업데이트 올리기 — 판정과 그 이유를 함께. 본문 없는 판정은 서버가 400 으로 거절한다.
export async function postProjectUpdateAction(
  id: string,
  input: { health: TrackerHealth; body: string }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.postProjectUpdate(ctx, id, input)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function addProjectMilestoneAction(
  id: string,
  input: { name: string; description?: string; targetDate?: string }
): Promise<ProjectActionResult> {
  const ctx = await authContext()
  try {
    const project = projectSchema.parse(await controlPlane.addProjectMilestone(ctx, id, input))
    return { ok: true, project }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 체크포인트를 지우면 그걸 가리키던 이슈들이 같은 동작에서 떨어져 나온다(서버가 한다).
export async function removeProjectMilestoneAction(
  id: string,
  milestoneId: string
): Promise<ProjectActionResult> {
  const ctx = await authContext()
  try {
    const project = projectSchema.parse(
      await controlPlane.removeProjectMilestone(ctx, id, milestoneId)
    )
    return { ok: true, project }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteProjectAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteProject(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
