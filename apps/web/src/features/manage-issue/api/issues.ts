'use server'

import { revalidatePath } from 'next/cache'

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
  priority?: IssuePriority
  estimate?: number
  dueDate?: string
  // 하위 이슈로 접수 — 부모는 이 워크스페이스에 있어야 한다(제어 평면이 404 로 거절).
  parentId?: string
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
    priority?: IssuePriority
    // null 은 비운다: 추정치 없음·기한 없음·부모에서 떼기.
    estimate?: number | null
    dueDate?: string | null
    parentId?: string | null
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
  resolution?: { scorecardId?: string; note?: string },
  // 보드 컬럼으로 옮긴 경우 — 컬럼이 곧 정규 상태라, 서버는 컬럼 쪽을 따른다.
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
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 다른 팀으로 넘기기. 식별자가 도착지 팀의 카운터로 다시 찍히므로, 성공하면 이슈의 주소 자체가 바뀐다 —
// 호출한 쪽은 돌아온 identifier 로 이동해야 한다(예전 이름도 계속 해석되지만, 정규 주소는 새 이름이다).
export async function moveIssueAction(id: string, teamId: string): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.moveIssue(ctx, id, teamId))
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 트리아지에서 나가는 두 길. 받아들이기는 워크플로로 들여보내고, 거절은 사유와 함께 취소한다 — 레코드는
// 남는다("우리가 거절했다"는 나중에 찾는 답이다).
export async function acceptTriageAction(id: string, status: IssueStatus): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.acceptTriage(ctx, id, status))
    revalidateIssues()
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function declineTriageAction(id: string, note?: string): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.declineTriage(ctx, id, note))
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
