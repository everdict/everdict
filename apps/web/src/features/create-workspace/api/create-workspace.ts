'use server'

import { revalidatePath } from 'next/cache'

import { setActiveWorkspace } from '@/shared/auth/active-workspace'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface CreateWorkspaceResult {
  ok: boolean
  id?: string
  name?: string
  error?: string
}

// Self-serve workspace creation (anyone) → the creator is admin. After creation, switch to that workspace immediately (cookie).
export async function createWorkspaceAction(input: {
  name: string
  id?: string
}): Promise<CreateWorkspaceResult> {
  const ctx = await authContext()
  try {
    const ws = await controlPlane.createWorkspace<{ id: string; name: string; role: string }>(ctx, {
      name: input.name,
      ...(input.id ? { id: input.id } : {}),
    })
    await setActiveWorkspace(ws.id)
    revalidatePath('/[workspace]', 'layout')
    return { ok: true, id: ws.id, name: ws.name }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
