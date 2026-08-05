'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Soft-delete dataset versions (tombstone — past scorecard results stay reproducible, but future runs referencing a
// deleted version fail to resolve). `versions` deletes exactly those; omitting it deletes the whole dataset (all own live
// versions). Backed by the control plane's bulk endpoint: it checks each target creator-or-admin and is atomic
// (fail-fast — nothing is deleted if any target is forbidden/absent), so this is one call, not a per-version fan-out.

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export async function deleteDatasetVersionsAction(input: {
  id: string
  versions?: string[]
}): Promise<{ ok: boolean; deleted: string[]; error?: string }> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.deleteDatasetVersions<{ deleted: string[] }>(
      ctx,
      input.id,
      input.versions
    )
    return { ok: true, deleted: res.deleted }
  } catch (e) {
    return { ok: false, deleted: [], error: e instanceof Error ? e.message : String(e) }
  }
}
