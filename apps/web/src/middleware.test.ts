import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

// Auth.js only decides whether the WRAPPED handler runs (Keycloak is unconfigured here, so it does not), and
// importing it for real drags next-auth's own module resolution into the suite. The identity wrapper is what
// the production branch uses when auth is off.
vi.mock('@/shared/auth/auth', () => ({ auth: (handler: unknown) => handler }))

const { default: exported } = await import('./middleware')
// Auth off is the branch under test, and that branch is the plain one-argument handler (the union with the
// Auth.js-wrapped one is what carries the second parameter).
const middleware = exported as (req: NextRequest) => Response
const { ACTIVE_WORKSPACE_HEADER } = await import('./shared/auth/workspace-scope')

// A workspace's ID is lowercase; its display NAME is what a person reads and types. `/Digo` therefore used to
// miss the slug pattern entirely: no workspace header was injected, `[workspace]/layout` found no membership
// for `Digo`, and it redirected into the reader's DEFAULT workspace — another workspace's data served under
// the address they asked for. Observed before the fix: `GET /Digo` → 307 `/default`.
//
// These drive the middleware itself rather than the predicate, because the defect was that the predicate was
// never consulted for this shape.

const request = (path: string): NextRequest =>
  new NextRequest(new URL(`http://localhost:3001${path}`))

describe('workspace addresses', () => {
  it('redirects a capitalised workspace segment to its canonical lowercase address', () => {
    const res = middleware(request('/Digo'))
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('http://localhost:3001/digo')
  })

  it('keeps the rest of the path and the query while normalising', () => {
    const res = middleware(request('/DiGo/issues/DIGO-1?comment=abc'))
    expect(res.headers.get('location')).toBe('http://localhost:3001/digo/issues/DIGO-1?comment=abc')
  })

  it('leaves a canonical address alone and injects it as the active workspace', () => {
    const res = middleware(request('/digo/issues'))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-request-' + ACTIVE_WORKSPACE_HEADER)).toBe('digo')
  })

  it('does not invent a workspace out of a reserved or non-slug segment', () => {
    for (const path of ['/Onboarding', '/_next/static/x.js', '/']) {
      const res = middleware(request(path))
      expect(res.headers.get('location')).toBeNull()
    }
  })
})
