'use server'

import {
  issueSchema,
  type Issue,
  type IssueLinkType,
  type IssuePriority,
  type IssueStatus,
} from '@/entities/issue'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Tracker issue server actions — a pure HTTP client of the control plane's /issues (authz is the control
// plane's: read issues:read · write issues:write · delete creator-or-admin). Transition facts
// (issue.status_changed etc.) are emitted server-side; nothing here decides legality.
//
// ⚠️ Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here.
// This app has no cache for it to invalidate (every page is `force-dynamic`, every control-plane call is `no-store` and
// `staleTimes.dynamic` is 0), and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the mere FACT that an
// action declared an invalidation. Every `<Link>` on screen then re-prefetches at once (23 of them on an issue detail) and the mutation's
// transition is queued behind them, so the spinner turns for seconds. The details are in `docs/web.md`.

export interface IssueActionResult {
  ok: boolean
  issue?: Issue
  error?: string
}

export async function createIssueAction(input: {
  title: string
  description?: string
  status?: IssueStatus
  priority?: IssuePriority
  estimate?: number
  dueDate?: string
  // Filed as a sub-issue — the parent must be in this workspace (the control plane refuses with a 404).
  parentId?: string
  projectId?: string
  assignee?: string
  labelIds?: string[]
  links?: { type: IssueLinkType; id: string; version?: string; note?: string }[]
}): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.createIssue(ctx, input))
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
    priority?: IssuePriority
    // The project checkpoint — only a milestone of the issue's own project is accepted
    // (attaching one on an issue with no project is refused with "put it in a project first").
    milestoneId?: string | null
    // null CLEARS: no estimate, no due date, detach from the parent.
    estimate?: number | null
    dueDate?: string | null
    parentId?: string | null
  }
): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.updateIssue(ctx, id, patch))
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
  resolution?: { scorecardId?: string; note?: string },
  // Moved to a board column — the column IS the canonical status, so the server follows the column side.
  stateId?: string
): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(
      await controlPlane.setIssueStatus(ctx, id, {
        status,
        ...(resolution ? { resolution } : {}),
        ...(stateId !== undefined ? { stateId } : {}),
      })
    )
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteIssueAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteIssue(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
