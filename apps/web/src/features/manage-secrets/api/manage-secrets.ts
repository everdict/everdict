'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SecretActionResult {
  ok: boolean
  error?: string
}

// 시크릿 set(이름+값). 값은 at-rest 암호화 후 절대 read-back 되지 않는다. authZ(admin=secrets:write)는 컨트롤플레인이 강제.
export async function setSecretAction(name: string, value: string): Promise<SecretActionResult> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: '이름이 비어 있습니다.' }
  if (value.length === 0) return { ok: false, error: '값이 비어 있습니다.' }
  const ctx = await authContext()
  try {
    await controlPlane.setSecret(ctx, trimmed, value)
    revalidatePath('/dashboard/secrets')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 시크릿 삭제. authZ(admin=secrets:write)는 컨트롤플레인이 강제.
export async function deleteSecretAction(name: string): Promise<SecretActionResult> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteSecret(ctx, name)
    revalidatePath('/dashboard/secrets')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
