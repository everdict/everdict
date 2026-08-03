'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { issueLabelSchema, type IssueLabel, type IssueLabelColor } from '@/entities/issue-label'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The workspace label registry's mutations (docs/tracker.md). One slice owns them so both callers — the settings
// manager and the issue picker's inline "create" — go through the same action, the `pick-secret` precedent.

export interface IssueLabelActionResult {
  ok: boolean
  label?: IssueLabel
  error?: string
}

// Every surface that draws a chip joins against the label list, so any definition change invalidates them all.
function revalidateLabels(): void {
  revalidatePath('/[workspace]/issues', 'page')
  revalidatePath('/[workspace]/issues/[id]', 'page')
  revalidatePath('/[workspace]/settings/labels', 'page')
}

export async function createIssueLabelAction(input: {
  name: string
  color: IssueLabelColor
  description?: string
}): Promise<IssueLabelActionResult> {
  const ctx = await authContext()
  try {
    const label = issueLabelSchema.parse(await controlPlane.createIssueLabel(ctx, input))
    revalidateLabels()
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
    revalidateLabels()
    return { ok: true, label }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteIssueLabelAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteIssueLabel(ctx, id)
    revalidateLabels()
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
