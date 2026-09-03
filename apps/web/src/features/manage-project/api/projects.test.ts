import { beforeEach, describe, expect, it, vi } from 'vitest'

// 회귀 테스트 — 프로젝트 변이도 `revalidatePath` 를 부르면 안 된다. 이유는 이슈 쪽과 같다
// (`features/manage-issue/api/issues.test.ts`): 무효화할 캐시는 없는데 Next 16 은 선언만으로 클라이언트
// prefetch 캐시를 통째로 버려, 이름 한 번 바꾸는 데 화면의 모든 `<Link>` 가 다시 prefetch 되고 그 큐가
// 드레인될 때까지 제목이 옛 이름으로 남아 있었다.
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath, revalidateTag: vi.fn() }))
vi.mock('@/shared/auth/principal', () => ({ authContext: async () => ({ devTenant: 'acme' }) }))

const PROJECT = {
  id: 'p1',
  tenant: 'acme',
  name: 'Hermes evaluation',
  status: 'planned',
  initiativeIds: [],
  createdBy: 'dev',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
}

vi.mock('@/shared/lib/control-plane', () => ({
  controlPlane: {
    updateProject: async (_ctx: unknown, _id: string, patch: Record<string, unknown>) => ({
      ...PROJECT,
      ...patch,
    }),
    setProjectStatus: async () => ({
      ok: true,
      status: 200,
      body: { ...PROJECT, status: 'in_progress' },
    }),
    postProjectUpdate: async () => undefined,
    deleteProject: async () => undefined,
  },
}))

const {
  deleteProjectAction,
  postProjectUpdateAction,
  setProjectStatusAction,
  updateProjectAction,
} = await import('./projects')

describe('project mutations', () => {
  beforeEach(() => {
    revalidatePath.mockClear()
  })

  it('renames without evicting the client prefetch cache', async () => {
    const r = await updateProjectAction('p1', { name: 'Hermes evaluation, round 2' })

    expect(r.ok).toBe(true)
    expect(r.project?.name).toBe('Hermes evaluation, round 2')
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('moves status without evicting it either', async () => {
    const r = await setProjectStatusAction('p1', 'in_progress')

    expect(r.ok).toBe(true)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('posts an update without evicting it either', async () => {
    const r = await postProjectUpdateAction('p1', {
      health: 'on_track',
      body: 'the harness is pinned',
    })

    expect(r.ok).toBe(true)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('deletes without evicting it either', async () => {
    const r = await deleteProjectAction('p1')

    expect(r.ok).toBe(true)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
