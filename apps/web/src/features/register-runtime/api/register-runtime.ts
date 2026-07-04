'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 컨트롤플레인 /runtimes/validate 응답(느슨 미러). ok=false 면 errors(스키마) 표시.
export interface ValidateRuntimeResult {
  ok: boolean
  errors?: string[]
  versionExists?: boolean
  referenced?: string[]
  missingSecrets?: string[]
  error?: string
}

// 스키마 검증 + 버전 충돌/참조 시크릿 확인(잡 안 돌림). 실패해도 폼은 살아있게 {ok:false} 반환.
export async function validateRuntimeAction(spec: unknown): Promise<ValidateRuntimeResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateRuntime<ValidateRuntimeResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 라이브 연결 테스트 — 실제 클러스터/데몬에 붙어 도달성·인증만 확인(잡 안 돌림).
export interface ProbeRuntimeResult {
  ok: boolean
  reachable?: boolean
  detail?: string
  error?: string
}

export async function probeRuntimeAction(spec: unknown): Promise<ProbeRuntimeResult> {
  const ctx = await authContext()
  try {
    const r = await controlPlane.probeRuntime<{ reachable: boolean; detail?: string }>(ctx, spec)
    return { ok: true, reachable: r.reachable, detail: r.detail }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface CreateRuntimeResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

// 등록(POST /runtimes). authZ(runtimes:write)는 컨트롤플레인이 강제. 불변 버전이라 같은 버전 재등록은 서버가 막는다.
export async function createRuntimeAction(spec: unknown): Promise<CreateRuntimeResult> {
  const ctx = await authContext()
  try {
    const r = await controlPlane.createRuntime<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/runtimes')
    revalidatePath('/[workspace]')
    return { ok: true, id: r.id, version: r.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
