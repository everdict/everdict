'use server'

import { revalidatePath } from 'next/cache'

import { issueSchema, type Issue, type IssueLinkType } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Issue ↔ capability links. Links are POINTERS — the control plane does not validate them (same semantics as
// a platform event's subject), so a link to something the reader cannot see simply renders as an unresolved
// reference rather than failing the write.

export interface IssueLinkActionResult {
  ok: boolean
  issue?: Issue
  error?: string
}

function revalidateIssue(): void {
  revalidatePath('/[workspace]/issues/[id]', 'page')
}

export async function addIssueLinkAction(
  id: string,
  link: { type: IssueLinkType; id: string; version?: string; note?: string }
): Promise<IssueLinkActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.addIssueLink(ctx, id, link))
    revalidateIssue()
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
    revalidateIssue()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
