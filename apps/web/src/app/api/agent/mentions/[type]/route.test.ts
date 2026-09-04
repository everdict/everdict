import { describe, expect, it, vi } from 'vitest'

// What this file locks down: the @-picker's issue search is the CONTROL PLANE's. The route passes `search` through and lets the server's
// narrowed answer past verbatim — filtering it again by substring would drop rows found by SERVER semantics (a match outside the identifier
// and title), and an issue outside the recent window would silently stop being findable in the picker. The other types, which fetch a whole
// window, are still filtered by the route.

vi.mock('@/shared/auth/principal', () => ({ authContext: async () => ({}) }))
vi.mock('@/shared/lib/control-plane', () => ({
  controlPlane: {
    listIssues: vi.fn(async (_ctx: unknown, filter?: { search?: string }) => ({
      // The server search looks into the description body too — the matched row's identifier and title do not contain the term.
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
    // The reference key is the identifier (ENG-12) and the label is the title — the row the SERVER found becomes the candidate verbatim.
    expect(body.items).toEqual([{ id: 'ENG-12', label: 'The judge drops cost scores' }])
  })

  it('still narrows window-fetched types in the route', async () => {
    const body = await get('harness', 'codex')

    expect(body.items).toEqual([{ id: 'codex', label: 'Codex CLI' }])
  })
})
