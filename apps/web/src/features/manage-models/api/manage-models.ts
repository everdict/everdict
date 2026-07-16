'use server'

import { revalidatePath } from 'next/cache'

import { saveModelResultSchema, testModelConnectionResultSchema } from '@/entities/model'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 커넥션 테스트(더미콜) 결과의 평탄한 뷰 — UI 는 ok/응답텍스트/사유만 쓴다. throw(네트워크/403)도 ok:false 로 흡수.
export interface TestConnectionActionResult {
  ok: boolean
  text?: string
  error?: string
  latencyMs?: number
}

// provider/model/baseUrl/apiKeySecret(이름) 로 최소 더미콜을 날려 응답이 오는지 확인. 실패는 4xx 가 아니라 ok:false 로 온다.
export async function testModelConnectionAction(
  connection: unknown
): Promise<TestConnectionActionResult> {
  const ctx = await authContext()
  try {
    const r = testModelConnectionResultSchema.parse(await controlPlane.testModelConnection(ctx, connection))
    return r.ok
      ? { ok: true, text: r.text, latencyMs: r.latencyMs }
      : { ok: false, error: r.error }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface SaveModelActionResult {
  ok: boolean
  version?: string
  created?: boolean
  error?: string
}

// 버전 없는 저장(PUT /models/:id). 새 id → 1.0.0, 커넥션 변경 → 내부 patch 자동 증가(새 불변 버전), 동일 → 멱등 no-op.
// authZ(models:write)/버전 배정은 컨트롤플레인이 담당.
export async function saveModelAction(id: string, body: unknown): Promise<SaveModelActionResult> {
  const ctx = await authContext()
  try {
    const r = saveModelResultSchema.parse(await controlPlane.saveModel(ctx, id, body))
    revalidatePath('/[workspace]/settings')
    return { ok: true, version: r.version, created: r.created }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 모델 전체 소프트-딜리트(DELETE /models/:id, versions 생략 = 이 워크스페이스 소유의 모든 라이브 버전). 툼스톤이라 이 모델을
// 참조했던 과거 스코어카드는 재현 가능하게 보존되지만, 이후 이 모델을 참조하는 실행은 해석에 실패한다. authZ(등록자-or-admin)는
// 컨트롤플레인이 강제 — fail-fast(하나라도 금지/부재면 아무것도 삭제 안 함).
export async function deleteModelAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteModelVersions<{ deleted: string[] }>(ctx, id)
    revalidatePath('/[workspace]/settings')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
