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

// self-serve 워크스페이스 생성(누구나) → 생성자는 admin. 생성 후 그 워크스페이스로 즉시 전환(쿠키).
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
    revalidatePath('/dashboard', 'layout')
    return { ok: true, id: ws.id, name: ws.name }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
