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
// ⚠️ Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws the whole prefetch cache away on the DECLARATION alone, so every `<Link>` on screen
// re-prefetches and the mutation's transition is bound behind that queue). The grounds are in `docs/web.md`.

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
    // The lists are replaced WHOLE — an empty array is the only way to express "detach them all".
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

// Post an update — the verdict together with its reason. A verdict with no body is refused by the server with a 400.
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

// Deleting a checkpoint detaches the issues pointing at it in the same operation (the server does it).
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
