import { beforeEach, describe, expect, it, vi } from 'vitest'

// A regression test — a project mutation must not call `revalidatePath` either. The reason is the issue side's
// (`features/manage-issue/api/issues.test.ts`): there is no cache to invalidate, and Next 16 throws away the whole client
// prefetch cache on the declaration alone, so one rename made every `<Link>` on screen re-prefetch and the title stayed at the
// old name until that queue drained.
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
