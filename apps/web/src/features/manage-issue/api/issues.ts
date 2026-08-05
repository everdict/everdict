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
// ⚠️ 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다.
// 이 앱에는 그것이 무효화할 캐시가 없고(페이지는 전부 `force-dynamic`, 제어 평면 호출은 전부 `no-store`,
// `staleTimes.dynamic` 은 0), Next 16 은 액션이 무효화를 선언했다는 사실만으로 클라이언트 prefetch 캐시를
// 통째로 버리고 300ms 쿨다운을 건다. 그러면 화면에 걸린 모든 `<Link>` 가 한꺼번에 다시 prefetch 되고
// (이슈 상세 기준 23개), 변이의 트랜지션이 그 큐에 묶여 스피너가 몇 초씩 돈다. 자세한 내용은 `docs/web.md`.

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
  // 하위 이슈로 접수 — 부모는 이 워크스페이스에 있어야 한다(제어 평면이 404 로 거절).
  parentId?: string
  // 바로 이터레이션에 넣기. 자기 팀의 사이클이어야 한다(제어 평면이 거절).
  cycleId?: string
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
    // 이터레이션에 넣고 빼기. 일을 주기로 끌어오는 것은 워크플로 전이가 아니라 계획 변경이라 평범한 편집이다
    // (제어 평면도 그렇게 본다). 자기 팀의 사이클만 받는다 — 다른 팀 것은 거절된다.
    cycleId?: string | null
    // null 은 비운다: 추정치 없음·기한 없음·부모에서 떼기.
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

// 여러 이슈를 한 이터레이션으로 옮기기 — 리니어의 일괄 편집. `null` 은 사이클에서 뺀다.
//
// 제어 평면에 일괄 엔드포인트를 새로 내지 않고 건별 편집을 펼친다: 이슈마다 "자기 팀의 사이클인가"를 서버가
// 그대로 판정해야 하고(일괄 경로를 따로 두면 그 판정이 두 벌이 된다), 부분 실패가 정상적인 결과이기 때문이다.
// 그래서 결과도 부분 실패를 그대로 말한다 — 열아홉 건이 옮겨졌는데 "실패"라고만 하면 다시 누르게 된다.
export async function moveIssuesToCycleAction(
  ids: string[],
  cycleId: string | null
): Promise<{ moved: number; failed: number; error?: string }> {
  const ctx = await authContext()
  const results = await Promise.all(
    ids.map((id) =>
      controlPlane
        .updateIssue(ctx, id, { cycleId })
        .then(() => ({ ok: true }) as const)
        .catch(
          (e: unknown) =>
            ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as const
        )
    )
  )
  const failures = results.filter((r) => !r.ok)
  const first = failures[0]
  return {
    moved: results.length - failures.length,
    failed: failures.length,
    ...(first !== undefined && !first.ok && first.error !== undefined
      ? { error: first.error }
      : {}),
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
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 트리아지에서 나가는 두 길. 받아들이기는 워크플로로 들여보내고, 거절은 사유와 함께 취소한다 — 레코드는
// 남는다("우리가 거절했다"는 나중에 찾는 답이다).
export async function acceptTriageAction(
  id: string,
  status: IssueStatus
): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.acceptTriage(ctx, id, status))
    return { ok: true, issue }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function declineTriageAction(id: string, note?: string): Promise<IssueActionResult> {
  const ctx = await authContext()
  try {
    const issue = issueSchema.parse(await controlPlane.declineTriage(ctx, id, note))
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
