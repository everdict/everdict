import { beforeEach, describe, expect, it, vi } from 'vitest'

// 회귀 테스트 — 이슈 변이는 `revalidatePath` 를 부르면 안 된다.
//
// 이 앱에는 그것이 무효화할 캐시가 없다(페이지는 `force-dynamic`, 제어 평면 호출은 `no-store`,
// `staleTimes.dynamic` 은 0). 그런데 Next 16 은 액션이 무효화를 선언했다는 사실만으로 클라이언트 prefetch
// 캐시를 통째로 버리고(`invalidateEntirePrefetchCache`) 300ms 쿨다운을 걸어, 화면에 걸린 모든 `<Link>` 가
// 한꺼번에 다시 prefetch 된다. 이슈 상세는 링크가 23개라 그 큐가 드레인될 때까지 변이의 트랜지션이 묶이고,
// 실측으로 프로젝트 배정 한 번이 4~12초 동안 스피너만 돌았다(네트워크는 0.7초에 끝나 있었다).
// 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 그쪽은 현재 라우트만 무효화하므로 폭풍이 없다.
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath, revalidateTag: vi.fn() }))
vi.mock('@/shared/auth/principal', () => ({ authContext: async () => ({ devTenant: 'acme' }) }))

const ISSUE = {
  id: 'i1',
  tenant: 'acme',
  number: 12,
  identifier: 'ENG-12',
  title: 'the judge drops cost scores',
  status: 'todo',
  createdBy: 'dev',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
}

vi.mock('@/shared/lib/control-plane', () => ({
  controlPlane: {
    updateIssue: async (_ctx: unknown, _id: string, patch: Record<string, unknown>) => ({
      ...ISSUE,
      ...patch,
    }),
    setIssueStatus: async () => ({ ...ISSUE, status: 'in_progress' }),
    deleteIssue: async () => undefined,
  },
}))

const { deleteIssueAction, setIssueStatusAction, updateIssueAction } = await import('./issues')

describe('issue mutations', () => {
  beforeEach(() => {
    revalidatePath.mockClear()
  })

  it('assigns a project without evicting the client prefetch cache', async () => {
    const r = await updateIssueAction('i1', { projectId: 'p1' })

    expect(r.ok).toBe(true)
    expect(r.issue?.projectId).toBe('p1')
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('moves status without evicting it either', async () => {
    const r = await setIssueStatusAction('i1', 'in_progress')

    expect(r.ok).toBe(true)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('deletes without evicting it either', async () => {
    const r = await deleteIssueAction('i1')

    expect(r.ok).toBe(true)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
