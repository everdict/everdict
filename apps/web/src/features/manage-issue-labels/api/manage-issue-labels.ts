'use server'

import { z } from 'zod'

import { issueLabelSchema, type IssueLabel, type IssueLabelColor } from '@/entities/issue-label'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The workspace label registry's mutations (docs/tracker.md). One slice owns them so both callers — the settings
// manager and the issue picker's inline "create" — go through the same action, the `pick-secret` precedent.
//
// ⚠️ Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws the whole prefetch cache away on the DECLARATION alone, so every `<Link>` on
// screen re-prefetches and the mutation's transition is bound behind that queue). The grounds are in `docs/web.md`.

export interface IssueLabelActionResult {
  ok: boolean
  label?: IssueLabel
  error?: string
}

export async function createIssueLabelAction(input: {
  name: string
  color: IssueLabelColor
  description?: string
}): Promise<IssueLabelActionResult> {
  const ctx = await authContext()
  try {
    const label = issueLabelSchema.parse(await controlPlane.createIssueLabel(ctx, input))
    return { ok: true, label }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function updateIssueLabelAction(
  id: string,
  patch: { name?: string; color?: IssueLabelColor; description?: string | null }
): Promise<IssueLabelActionResult> {
  const ctx = await authContext()
  try {
    const label = issueLabelSchema.parse(await controlPlane.updateIssueLabel(ctx, id, patch))
    return { ok: true, label }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteIssueLabelAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteIssueLabel(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const usageSchema = z.object({ issues: z.number() })

// Read before a delete confirmation — "this comes off N issues" is the one thing the member cannot see from
// the list itself, and the strip is irreversible.
export async function issueLabelUsageAction(id: string): Promise<{ issues: number } | undefined> {
  const ctx = await authContext()
  try {
    return usageSchema.parse(await controlPlane.issueLabelUsage(ctx, id))
  } catch {
    return undefined
  }
}
