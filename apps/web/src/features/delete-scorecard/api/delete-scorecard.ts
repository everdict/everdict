'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Hard-delete a terminal scorecard (record + child runs). The control plane authorizes (the batch's creator or a
// workspace admin) and rejects an in-flight batch with a conflict (stop it first) — the failure message is returned
// instead of thrown so the dialog can surface it inline (same posture as delete-judge's per-version failures).

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export async function deleteScorecardAction(input: {
  id: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteScorecard(ctx, input.id)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true }
}
