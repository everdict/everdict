'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { projectSchema, type Project, type ProjectStatus } from '@/entities/project'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Tracker project server actions. The one interesting operation is completion: it is a GATE, refused with a
// 409 while the project has open issues. `force` is the deliberate override (a release ships with known gaps)
// and is recorded on the fact, so the history says the deadline was overridden rather than met.

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

function revalidateProjects(): void {
  revalidatePath('/[workspace]/projects', 'page')
  revalidatePath('/[workspace]/projects/[id]', 'page')
}

export async function createProjectAction(input: {
  name: string
  description?: string
  initiativeId?: string
  targetDate?: string
}): Promise<ProjectActionResult> {
  const ctx = await authContext()
  try {
    const project = projectSchema.parse(await controlPlane.createProject(ctx, input))
    revalidateProjects()
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
    initiativeId?: string | null
    targetDate?: string | null
  }
): Promise<ProjectActionResult> {
  const ctx = await authContext()
  try {
    const project = projectSchema.parse(await controlPlane.updateProject(ctx, id, patch))
    revalidateProjects()
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
      revalidateProjects()
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

export async function deleteProjectAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteProject(ctx, id)
    revalidateProjects()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
