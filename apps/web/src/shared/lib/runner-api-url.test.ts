import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two server-only inputs this module reads. Mocked rather than stubbed into globals so the module under
// test stays the real one.
const envMock = {
  CONTROL_PLANE_URL: 'http://api:8787',
  CONTROL_PLANE_PUBLIC_URL: undefined as string | undefined,
  CONTROL_PLANE_WS_URL: undefined as string | undefined,
}
const requestHost = { value: 'everdict.example.com:3001' as string | null }

vi.mock('server-only', () => ({}))
vi.mock('@/shared/config/env', () => ({ env: envMock }))
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'host' ? requestHost.value : null) }),
}))

const { resolveClientWsBase, resolveRunnerApiUrl } = await import('./runner-api-url')

describe('resolveClientWsBase — the base a BROWSER dials, not the one this server dials', () => {
  beforeEach(() => {
    envMock.CONTROL_PLANE_URL = 'http://api:8787'
    envMock.CONTROL_PLANE_PUBLIC_URL = undefined
    envMock.CONTROL_PLANE_WS_URL = undefined
    requestHost.value = 'everdict.example.com:3001'
  })

  it('never hands a browser the compose-internal host, port and path preserved', async () => {
    // `ws://api:8787` is what a scheme swap produced, and it fails at DNS in every browser outside the
    // compose network — the profile wizard, the run screen and the run terminal, all three.
    const base = await resolveClientWsBase()
    expect(base).toBe('ws://everdict.example.com:8787')
    expect(base).not.toContain('api:8787')
  })

  it('rebases a loopback control plane too, and keeps wss for an https origin', async () => {
    envMock.CONTROL_PLANE_URL = 'https://127.0.0.1:8787'
    expect(await resolveClientWsBase()).toBe('wss://everdict.example.com:8787')
  })

  it('an explicit CONTROL_PLANE_WS_URL wins verbatim — the operator has stated the client-facing origin', async () => {
    envMock.CONTROL_PLANE_WS_URL = 'wss://everdict.example.com/api/'
    expect(await resolveClientWsBase()).toBe('wss://everdict.example.com/api')
  })

  it('leaves a real public host alone (it is an intentional origin, not an internal default)', async () => {
    envMock.CONTROL_PLANE_URL = 'https://cp.example.com'
    expect(await resolveClientWsBase()).toBe('wss://cp.example.com')
    expect(await resolveRunnerApiUrl()).toBe('https://cp.example.com')
  })
})
