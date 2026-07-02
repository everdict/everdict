'use server'

import { revalidatePath } from 'next/cache'

import { bundleApplyResultSchema, type BundleApplyResult } from '@/entities/bundle'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ApplyBundleResult {
  ok: boolean
  result?: BundleApplyResult
  error?: string
}

// 서버 액션: 번들(JSON) 적용. 스키마/권한/멱등은 컨트롤플레인이 강제 — 여기선 파싱만 선처리하고 결과를 그대로 돌려준다.
export async function applyBundleAction(bundleJson: string): Promise<ApplyBundleResult> {
  const ctx = await authContext()
  let bundle: unknown
  try {
    bundle = JSON.parse(bundleJson)
  } catch {
    return { ok: false, error: '번들 JSON 파싱 실패' }
  }
  try {
    const raw = await controlPlane.applyBundle<unknown>(ctx, bundle)
    revalidatePath('/[workspace]/bundles')
    return { ok: true, result: bundleApplyResultSchema.parse(raw) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
