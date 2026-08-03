'use server'

import { revalidatePath } from 'next/cache'

import { issueSchema, type Issue, type IssueLinkType, type IssueStatus } from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Tracker issue server actions — a pure HTTP client of the control plane's /issues (authz is the control
// plane's: read issues:read · write issues:write · delete creator-or-admin). Transition facts
// (issue.status_changed etc.) are emitted server-side; nothing here decides legality.

export interface IssueActionResult {
  ok: boolean
  issue?: Issue
  error?: string
}

function revalidateIssues(): void {
  revalidatePath('/[workspace]/issues', 'page')
  revalidatePath('/[workspace]/issues/[id]', 'page')
}

export async function createIssueAction(input: {
  title: string
  description?: string
  status?: IssueStatus
  projectId?: string
  assignee?: string
  labelIds?: string[]
  links?: { type: IssueLinkType; id: string; version?: string; note?: string }[]
}): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.createIssue(ctx, input))
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Content editing only — `null` clears an optional field (unassign, detach from a project). A status move is
// never a side effect of a rename, so it lives on its own action.
export async function updateIssueAction(
  id: string,
  patch: {
    title?: string
    description?: string | null
    labelIds?: string[]
    assignee?: string | null
    projectId?: string | null
  }
): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.updateIssue(ctx, id, patch))
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Say where the issue should END UP; the control plane picks the transition that fits its current state.
// `done` carries the resolution (the scorecard that proved it + the human note) — that is what closing means.
export async function setIssueStatusAction(
  id: string,
  status: IssueStatus,
  resolution?: { scorecardId?: string; note?: string }
): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(
      await controlPlane.setIssueStatus(ctx, id, {
        status,
        ...(resolution ? { resolution } : {}),
      })
    )
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteIssueAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteIssue(ctx, id)
    revalidateIssues()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
