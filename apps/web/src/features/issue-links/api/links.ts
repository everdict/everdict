'use server'

import { issueSchema, type Issue, type IssueLinkType } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Issue ↔ capability links. Links are POINTERS — the control plane does not validate them (same semantics as
// a platform event's subject), so a link to something the reader cannot see simply renders as an unresolved
// reference rather than failing the write.
//
// ⚠️ Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws the whole prefetch cache away on the DECLARATION alone, so every `<Link>` on
// screen re-prefetches and the mutation's transition is bound behind that queue). The grounds are in `docs/web.md`.

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
