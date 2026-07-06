'use server'

import { revalidatePath } from 'next/cache'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 버전 태그 전체 교체(빈 배열 = 모두 제거) — 스펙 밖 자유 라벨(버전 분간용). authZ 는 컨트롤플레인이 강제
// (harnesses:register / datasets:write / runtimes:write; _shared·타 워크스페이스 버전은 404).
export type VersionTagEntity = 'harness' | 'dataset' | 'runtime'

export async function setVersionTagsAction(input: {
  entity: VersionTagEntity
  id: string
  version: string
  tags: string[]
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    if (input.entity === 'harness')
      await controlPlane.setHarnessVersionTags(ctx, input.id, input.version, input.tags)
    else if (input.entity === 'dataset')
      await controlPlane.setDatasetVersionTags(ctx, input.id, input.version, input.tags)
    else await controlPlane.setRuntimeVersionTags(ctx, input.id, input.version, input.tags)
    // 상세/목록/실행 폼 어디서든 최신 태그가 보이도록 광범위 재검증(댓글 액션과 동일 패턴).
    revalidatePath('/[workspace]', 'layout')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
