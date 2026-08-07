import { describe, expect, it, vi } from 'vitest'

// 이 파일이 잠그는 것: @-피커의 이슈 검색은 제어 평면이 한다. 라우트는 `search` 를 넘겨 서버가 좁힌 답을
// 그대로 통과시켜야 한다 — 서버 의미론(식별자·제목 밖 매치)으로 찾은 행을 부분문자열로 한 번 더 걸러
// 떨어뜨리면, 최근 창 밖의 이슈는 피커에서 조용히 못 찾게 된다. 창 전체를 받아오는 나머지 타입은
// 여전히 라우트가 거른다.

vi.mock('@/shared/auth/principal', () => ({ authContext: async () => ({}) }))
vi.mock('@/shared/lib/control-plane', () => ({
  controlPlane: {
    listIssues: vi.fn(async (_ctx: unknown, filter?: { search?: string }) => ({
      // 서버 검색은 설명 본문까지 본다 — 매치된 행의 식별자·제목에는 검색어가 없다.
      items:
        filter?.search === 'flaky'
          ? [{ id: 'uuid-1', identifier: 'ENG-12', title: 'The judge drops cost scores' }]
          : [],
    })),
    listHarnesses: vi.fn(async () => [
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'codex', name: 'Codex CLI' },
    ]),
  },
}))

const { GET } = await import('./route')
const { controlPlane } = await import('@/shared/lib/control-plane')

async function get(type: string, q?: string): Promise<{ items: unknown[] }> {
  const url = `http://web.test/api/agent/mentions/${type}${q ? `?q=${encodeURIComponent(q)}` : ''}`
  const res = await GET(new Request(url), { params: Promise.resolve({ type }) })
  return (await res.json()) as { items: unknown[] }
}

describe('mention-picker search route', () => {
  it('passes the control plane search verbatim and keeps its answer', async () => {
    const body = await get('issue', 'flaky')

    expect(vi.mocked(controlPlane.listIssues)).toHaveBeenCalledWith(expect.anything(), {
      search: 'flaky',
      limit: 50,
    })
    // 참조 키는 식별자(ENG-12), 라벨은 제목 — 서버가 찾은 행이 그대로 후보가 된다.
    expect(body.items).toEqual([{ id: 'ENG-12', label: 'The judge drops cost scores' }])
  })

  it('still narrows window-fetched types in the route', async () => {
    const body = await get('harness', 'codex')

    expect(body.items).toEqual([{ id: 'codex', label: 'Codex CLI' }])
  })
})
