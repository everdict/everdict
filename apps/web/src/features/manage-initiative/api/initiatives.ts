'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { initiativeSchema, type Initiative, type InitiativeStatus } from '@/entities/initiative'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Tracker initiative server actions. Completing an initiative is the RELEASE gate: refused with a 409 while
// any issue under any of its projects is open. `force` ships with known gaps and is recorded on the fact.

export interface InitiativeActionResult {
  ok: boolean
  initiative?: Initiative
  error?: string
  // Set when the release gate refused — the count of issues still open across the umbrella.
  blockedBy?: number
}

const gatePayloadSchema = z.object({ openIssues: z.number() })
const errorEnvelopeSchema = z.object({
  message: z.string().optional(),
  data: z.unknown().optional(),
})

function revalidateInitiatives(): void {
  revalidatePath('/[workspace]/initiatives', 'page')
  revalidatePath('/[workspace]/initiatives/[id]', 'page')
}

export async function createInitiativeAction(input: {
  name: string
  description?: string
  targetDate?: string
}): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const initiative = initiativeSchema.parse(await controlPlane.createInitiative(ctx, input))
    revalidateInitiatives()
    return { ok: true, initiative }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Projects join an initiative from the PROJECT side (PATCH /projects/:id), so membership is not editable here.
export async function updateInitiativeAction(
  id: string,
  patch: { name?: string; description?: string | null; targetDate?: string | null }
): Promise<InitiativeActionResult> {
  const ctx = await authContext()
  try {
    const initiative = initiativeSchema.parse(await controlPlane.updateInitiative(ctx, id, patch))
    revalidateInitiatives()
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
      revalidateInitiatives()
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

export async function deleteInitiativeAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteInitiative(ctx, id)
    revalidateInitiatives()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
