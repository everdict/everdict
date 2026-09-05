import { beforeEach, describe, expect, it, vi } from 'vitest'

// A regression test — an issue mutation must not call `revalidatePath`.
//
// This app has no cache for it to invalidate (pages are `force-dynamic`, control-plane calls are `no-store` and
// `staleTimes.dynamic` is 0). Yet Next 16 throws away the whole client prefetch cache on the mere FACT that an action declared an
// invalidation (`invalidateEntirePrefetchCache`) and imposes a 300ms cooldown, so every `<Link>` on screen re-prefetches at once.
// An issue detail has 23 links, so the mutation's transition is bound until that queue drains, and one measured project assignment spun a
// spinner for 4–12 seconds (with the network finished in 0.7).
// Refreshing the screen is the CALLER's `refresh()` — that invalidates the current route only, so there is no storm.
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
