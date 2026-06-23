'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ValidateRuntimeResult {
  ok: boolean
  errors?: string[]
  existingVersions?: string[]
  versionExists?: boolean
  id?: string
  version?: string
  kind?: string
  // spec 이 참조하는 시크릿 이름(authSecret/kubeconfigSecret) 중 SecretStore 에 아직 없는 것들(경고; 하드 실패 아님).
  missingSecrets?: string[]
  error?: string
}

export interface CreateRuntimeResult {
  ok: boolean
  id?: string
  version?: string
  error?: string
}

export interface ProbeRuntimeResult {
  kind?: string
  reachable?: boolean
  detail?: string
  error?: string // 프로브 호출 자체(인증/네트워크) 실패
}

// dry-run 검증: 스키마 + 이 워크스페이스의 기존 버전/충돌(등록하지 않음). authZ/검증은 컨트롤플레인이 강제.
export async function validateRuntimeAction(spec: unknown): Promise<ValidateRuntimeResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.validateRuntime<ValidateRuntimeResult>(ctx, spec)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 연결 테스트(라이브): 잡 없이 실제 클러스터에 붙어 도달성/인증을 확인. authZ(admin)는 컨트롤플레인이 강제.
export async function probeRuntimeAction(spec: unknown): Promise<ProbeRuntimeResult> {
  const ctx = await authContext()
  try {
    return await controlPlane.probeRuntime<ProbeRuntimeResult>(ctx, spec)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

// 등록(커밋). 스키마 검증/불변성(409)/authZ(admin)은 컨트롤플레인이 강제한다.
export async function createRuntimeAction(spec: unknown): Promise<CreateRuntimeResult> {
  const ctx = await authContext()
  try {
    const rec = await controlPlane.createRuntime<{ id: string; version: string }>(ctx, spec)
    revalidatePath('/[workspace]/runtimes')
    return { ok: true, id: rec.id, version: rec.version }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
