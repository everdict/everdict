import { beforeEach, describe, expect, it, vi } from 'vitest'

// 팀 이관 변이도 `revalidatePath` 를 부르면 안 된다 — 무효화할 캐시가 없는데 Next 16 은 선언만으로
// 클라이언트 prefetch 캐시를 통째로 버린다(features/manage-issue/api/issues.test.ts 에 실측 근거).
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath, revalidateTag: vi.fn() }))
vi.mock('@/shared/auth/principal', () => ({ authContext: async () => ({ devTenant: 'acme' }) }))

const calls: { kind: string; id: string; teamId: string }[] = []
vi.mock('@/shared/lib/control-plane', () => ({
  controlPlane: {
    moveCapabilityTeam: async (_ctx: unknown, kind: string, id: string, teamId: string) => {
      calls.push({ kind, id, teamId })
      if (teamId === 'team_secret') throw new Error('FORBIDDEN: This belongs to a team you are not on')
      return { workspace: 'acme', id, teamId, previousTeamId: 'team_eng' }
    },
  },
}))

const { moveToTeamAction } = await import('./move-to-team')

describe('moveToTeamAction', () => {
  beforeEach(() => {
    revalidatePath.mockClear()
    calls.length = 0
  })

  it('re-files the capability under the destination team and reports it back', async () => {
    const r = await moveToTeamAction('datasets', 'swe-mini', 'team_platform')

    expect(r).toEqual({ ok: true, teamId: 'team_platform' })
    expect(calls).toEqual([{ kind: 'datasets', id: 'swe-mini', teamId: 'team_platform' }])
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('addresses each resource kind on its own path — one act, five owners', async () => {
    await moveToTeamAction('harnesses', 'claude-code', 'team_platform')
    await moveToTeamAction('scorecards', 'sc_1', 'team_platform')

    expect(calls.map((c) => c.kind)).toEqual(['harnesses', 'scorecards'])
  })

  it("surfaces the control plane's refusal verbatim instead of guessing a next step", async () => {
    const r = await moveToTeamAction('judges', 'truncation', 'team_secret')

    expect(r.ok).toBe(false)
    expect(r.error).toContain('FORBIDDEN')
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
