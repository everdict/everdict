'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데, Next 16 은 선언만으로 클라이언트 prefetch 캐시를 통째로 버리고 300ms 쿨다운을
// 건다). 근거는 `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface StopScorecardResult {
  ok: boolean
  error?: string
}

// Server action: stop a running/queued batch with the authenticated user token. AuthZ is enforced by the control
// plane (scorecards:run — may 403; already-terminal → 409; other workspace / missing → 404). The scorecard's own
// AutoRefresh reflects the new `cancelled` status; 목록의 상태 칩은 부른 쪽의 `refresh()` 가 갱신한다.
export async function stopScorecardAction(id: string): Promise<StopScorecardResult> {
  const ctx = await authContext()
  try {
    await controlPlane.cancelScorecard(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
