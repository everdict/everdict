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
  link: {
    type: IssueLinkType
    id: string
    version?: string
    // `commit` links only — the repository the sha lives in, and the Enterprise host when there is one. A
    // commit is the first link target outside the workspace, so it is the first that needs an address rather
    // than an id (contracts `issueLinkDefects` refuses one without it, at this door and at the transition).
    repository?: string
    host?: string
    note?: string
  }
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
  linkId: string,
  // The second coordinate, for the kinds that carry one. Two datasets can each hold a case called `c1` and two
  // repositories can each hold a sha with the same abbreviation, so a removal by id alone takes both.
  where?: { dataset?: string; repository?: string }
): Promise<IssueLinkActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.removeIssueLink(ctx, id, type, linkId, where))
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
