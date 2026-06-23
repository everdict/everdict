'use server'

import { revalidatePath } from 'next/cache'

import { type ApiKeyScope, createApiKeyInputSchema, createdApiKeySchema } from '@/entities/api-key'
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

// API 키 발급. scopes 로 권한을 좁힐 수 있다(미지정=Full Access). authZ(admin=keys:write)는 컨트롤플레인이 강제.
export async function createKeyAction(label?: string, scopes?: ApiKeyScope[]): Promise<CreateKeyResult> {
  const ctx = await authContext()
  try {
    // 경계 검증(컨트롤플레인이 다시 강제하지만 잘못된 입력은 여기서 거른다). 빈 배열/미지정 scopes 는 보내지 않음(=Full Access).
    const body = createApiKeyInputSchema.parse({
      label: label && label.length > 0 ? label : undefined,
      scopes: scopes && scopes.length > 0 ? scopes : undefined,
    })
    const res = createdApiKeySchema.parse(await controlPlane.createKey(ctx, body))
    revalidatePath('/[workspace]/account')
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
    revalidatePath('/[workspace]/account')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
