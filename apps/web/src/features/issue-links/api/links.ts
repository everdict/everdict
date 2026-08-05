'use server'

import { issueSchema, type Issue, type IssueLinkType } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Issue ↔ capability links. Links are POINTERS — the control plane does not validate them (same semantics as
// a platform event's subject), so a link to something the reader cannot see simply renders as an unresolved
// reference rather than failing the write.
//
// ⚠️ 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다
// (무효화할 캐시가 없는데 Next 16 은 선언만으로 prefetch 캐시를 통째로 버려 화면의 모든 `<Link>` 가
// 다시 prefetch 되고, 변이의 트랜지션이 그 큐에 묶인다). 근거는 `docs/web.md`.

export interface IssueLinkActionResult {
  ok: boolean
  issue?: Issue
  error?: string
}

export async function addIssueLinkAction(
  id: string,
  link: { type: IssueLinkType; id: string; version?: string; note?: string }
): Promise<IssueLinkActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.addIssueLink(ctx, id, link))
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function removeIssueLinkAction(
  id: string,
  type: IssueLinkType,
  linkId: string
): Promise<IssueLinkActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.removeIssueLink(ctx, id, type, linkId))
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
