'use server'

import { revalidatePath } from 'next/cache'

import { createdApiKeySchema } from '@/entities/api-key'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface CreateKeyResult {
  ok: boolean
  apiKey?: string // 평문(ak_…) — 1회만. 모달에 보여주고 버린다.
  error?: string
}

export interface RevokeKeyResult {
  ok: boolean
  error?: string
}

// API 키 발급. 발급된 키는 이 워크스페이스 ADMIN 권한을 가진다. authZ(admin=keys:write)는 컨트롤플레인이 강제.
export async function createKeyAction(label?: string): Promise<CreateKeyResult> {
  const ctx = await authContext()
  try {
    const body = label && label.length > 0 ? { label } : {}
    const res = createdApiKeySchema.parse(await controlPlane.createKey(ctx, body))
    revalidatePath('/dashboard/account')
    return { ok: true, apiKey: res.apiKey }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// API 키 취소(즉시 무효). authZ(admin=keys:write)는 컨트롤플레인이 강제.
export async function revokeKeyAction(id: string): Promise<RevokeKeyResult> {
  const ctx = await authContext()
  try {
    await controlPlane.revokeKey(ctx, id)
    revalidatePath('/dashboard/account')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
