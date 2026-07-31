'use server'

import { revalidatePath } from 'next/cache'

import {
  adoptedEnvironmentSchema,
  adoptedEnvironmentsResponseSchema,
  type AdoptedEnvironment,
} from '@/entities/environment-adoption'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Workspace environment-image adoption ("import") — bring an environment into the workspace inventory with a
// pull-usability verification (warn-not-block). authZ (capabilities:read / settings:write) is control-plane enforced.
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// 환경 인벤토리/가져옴 상태를 렌더하는 표면 — 스토어(카탈로그·내 발행·상세)와 설정의 Environments 페이지.
function revalidateEnvironmentPages(): void {
  for (const path of [
    '/[workspace]/store',
    '/[workspace]/store/mine',
    '/[workspace]/settings/environments',
  ])
    revalidatePath(path)
  // 가져오기/제거·재검증을 누르는 자리 — 동적 세그먼트라 'page' 타입으로 지정해야 매칭된다.
  revalidatePath('/[workspace]/store/[source]/[id]', 'page')
}

export async function listAdoptedEnvironmentsAction(): Promise<
  { ok: true; environments: AdoptedEnvironment[] } | { ok: false; error: string }
> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.listAdoptedEnvironments(ctx)
    return { ok: true, environments: adoptedEnvironmentsResponseSchema.parse(raw).environments }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

export async function adoptEnvironmentAction(ref: {
  source: string
  id: string
  version: string
}): Promise<{ ok: true; environment: AdoptedEnvironment } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.adoptEnvironment(ctx, ref)
    revalidateEnvironmentPages()
    return { ok: true, environment: adoptedEnvironmentSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

export async function verifyAdoptedEnvironmentAction(
  source: string,
  id: string
): Promise<{ ok: true; environment: AdoptedEnvironment } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    const raw = await controlPlane.verifyAdoptedEnvironment(ctx, { source, id })
    revalidateEnvironmentPages()
    return { ok: true, environment: adoptedEnvironmentSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}

export async function unadoptEnvironmentAction(
  source: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.unadoptEnvironment(ctx, source, id)
    revalidateEnvironmentPages()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
}
