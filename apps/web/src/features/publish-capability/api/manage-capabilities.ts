'use server'

import { revalidatePath } from 'next/cache'

import {
  capabilitySchema,
  saveCapabilityResultSchema,
  type Capability,
  type CapabilitySpec,
  type CapabilityVisibility,
  type SaveCapabilityResult,
} from '@/entities/capability'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface SaveCapabilityInput {
  name: string
  description: string
  spec: CapabilitySpec
  visibility?: CapabilityVisibility
  sharedWith?: string[]
  tags?: string[]
}

export interface SaveCapabilityActionResult {
  ok: boolean
  result?: SaveCapabilityResult
  error?: string
}

// capability 발행/편집(PUT /capabilities/:id) — 버전 없는 upsert(새 id→1.0.0, 콘텐츠 변경→패치 범프). owner-or-admin,
// public 발행은 admin(컨트롤플레인 강제). visibility/sharedWith 는 생성 시에만, 편집은 현재 reach 상속.
export async function saveCapabilityAction(
  id: string,
  body: SaveCapabilityInput
): Promise<SaveCapabilityActionResult> {
  const ctx = await authContext()
  try {
    const result = saveCapabilityResultSchema.parse(
      await controlPlane.saveCapability(ctx, id, body)
    )
    revalidatePath('/[workspace]/store')
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CapabilityActionResult {
  ok: boolean
  capability?: Capability
  error?: string
}

// capability 공개범위 변경(PATCH /capabilities/:id/visibility) — 전 라이브 버전 관통. owner-or-admin, public 은 admin.
export async function setCapabilityVisibilityAction(
  id: string,
  body: { visibility: CapabilityVisibility; sharedWith: string[] }
): Promise<CapabilityActionResult> {
  const ctx = await authContext()
  try {
    const capability = capabilitySchema.parse(
      await controlPlane.setCapabilityVisibility(ctx, id, body)
    )
    revalidatePath('/[workspace]/store')
    return { ok: true, capability }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// capability 버전 삭제(DELETE /capabilities/:id/versions/:version) — 버전의 작성자-or-admin(컨트롤플레인).
export async function deleteCapabilityVersionAction(
  id: string,
  version: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteCapabilityVersion(ctx, id, version)
    revalidatePath('/[workspace]/store')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
