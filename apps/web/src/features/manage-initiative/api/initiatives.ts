'use server'

import { z } from 'zod'

import { initiativeSchema, type Initiative, type InitiativeStatus } from '@/entities/initiative'
import { projectSchema } from '@/entities/project'
import type { TrackerHealth } from '@/entities/tracker-health'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Tracker initiative server actions. Completing an initiative is a GATE: refused with a 409 while any issue
// under any of its projects is open. `force` closes it with known gaps and is recorded on the fact.
//
// ⚠️ Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws the whole prefetch cache away on the DECLARATION alone, so every `<Link>` on screen
// re-prefetches and the mutation's transition is bound behind that queue). The grounds are in `docs/web.md`.

export interface InitiativeActionResult {
  ok: boolean
  initiative?: Initiative
  error?: string
  // Set when the completion gate refused — the count of issues still open under the goal.
  blockedBy?: number
}

const gatePayloadSchema = z.object({ openIssues: z.number() })
const errorEnvelopeSchema = z.object({
  message: z.string().optional(),
  data: z.unknown().optional(),
})

export async function createInitiativeAction(input: {
  name: string
  description?: string
  // The parent initiative — progress sweeps up from below, so splitting still leaves ONE answer.
  parentId?: string
  lead?: string
  icon?: string
  targetDate?: string
}): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const initiative = initiativeSchema.parse(await controlPlane.createInitiative(ctx, input))
    return { ok: true, initiative }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Adding work to a goal, from the GOAL's side. The link itself still lives on the project (`initiativeIds`) —
// one project serves several goals, so the list belongs where the project is — but "which projects count toward
// this" is a question asked while looking at the goal, and answering it anywhere else means leaving the screen
// that asked. So this reads each chosen project and rewrites its list; there is no second way to be in an
// initiative, and therefore nothing new to keep consistent.
//
// The current list comes from the SERVER rather than from the picker's props: the patch replaces the array
// wholesale, so merging against a page that has been open for a while would silently drop a goal somebody else
// added in the meantime.
async function relinkProjects(
  projectIds: readonly string[],
  next: (current: string[]) => string[]
): Promise<{ ok: boolean; error?: string; changed: number }> {
  const ctx = await authContext()
  let changed = 0
  for (const projectId of projectIds) {
    try {
      const project = projectSchema.parse(await controlPlane.getProject(ctx, projectId))
      const initiativeIds = next(project.initiativeIds)
      // Same set (a double click, a stale tab) — nothing to write, and nothing to report as a failure.
      if (initiativeIds.length === project.initiativeIds.length) continue
      await controlPlane.updateProject(ctx, projectId, { initiativeIds })
      changed += 1
    } catch (e) {
      // Stop at the first refusal and say which project it was: a partial link is confusing enough without
      // also being silent about where it stopped.
      return { ok: false, error: e instanceof Error ? e.message : String(e), changed }
    }
  }
  return { ok: true, changed }
}

export async function addProjectsToInitiativeAction(
  initiativeId: string,
  projectIds: string[]
): Promise<{ ok: boolean; error?: string; changed: number }> {
  return relinkProjects(projectIds, (current) =>
    current.includes(initiativeId) ? current : [...current, initiativeId]
  )
}

export async function removeProjectFromInitiativeAction(
  initiativeId: string,
  projectId: string
): Promise<{ ok: boolean; error?: string; changed: number }> {
  // Removing a project from a goal does not touch the project itself — it goes on being somebody's work, it just
  // stops counting toward this goal.
  return relinkProjects([projectId], (current) => current.filter((id) => id !== initiativeId))
}

export async function updateInitiativeAction(
  id: string,
  patch: {
    name?: string
    description?: string | null
    // null detaches it from its parent and returns it to the top level.
    parentId?: string | null
    // null clears the lead — that nobody has taken it on yet is a real state.
    lead?: string | null
    // The lists are replaced WHOLE — the editor sends the result set, and merging could not express a removal.
    memberIds?: string[]
    icon?: string | null
    resources?: { label: string; url: string }[]
    targetDate?: string | null
  }
): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const initiative = initiativeSchema.parse(await controlPlane.updateInitiative(ctx, id, patch))
    return { ok: true, initiative }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function setInitiativeStatusAction(
  id: string,
  status: InitiativeStatus,
  force?: boolean
): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.setInitiativeStatus(ctx, id, {
      status,
      ...(force ? { force: true } : {}),
    })
    if (res.ok) {
      const initiative = initiativeSchema.parse(res.body)
      return { ok: true, initiative }
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
export async function postInitiativeUpdateAction(
  id: string,
  input: { health: TrackerHealth; body: string }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.postInitiativeUpdate(ctx, id, input)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteInitiativeAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteInitiative(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
