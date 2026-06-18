'use server'

import { revalidatePath } from 'next/cache'

import { currentTenant } from '@/shared/auth/tenant'
import { controlPlane } from '@/shared/lib/control-plane'

export interface RegisterHarnessResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// 서버 액션: HarnessSpec(JSON)을 테넌트 소유로 등록. 스펙 검증/불변성(409)은 컨트롤플레인이 강제한다.
export async function registerHarnessAction(json: string): Promise<RegisterHarnessResult> {
  const { tenant } = await currentTenant()
  let spec: unknown
  try {
    spec = JSON.parse(json)
  } catch {
    return { ok: false, error: 'JSON 파싱 실패 — 유효한 HarnessSpec JSON 을 입력하세요.' }
  }
  try {
    const rec = await controlPlane.registerHarness<{ id: string; version: string }>(tenant, spec)
    revalidatePath('/dashboard/harnesses')
    revalidatePath('/dashboard')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
