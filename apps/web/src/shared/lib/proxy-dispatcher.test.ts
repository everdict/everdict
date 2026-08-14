import { describe, expect, it } from 'vitest'

import { proxyEnv } from './proxy-dispatcher'

describe('proxyEnv — NO_PROXY is the union of both spellings', () => {
  it('merges NO_PROXY and no_proxy instead of picking one — compose and the host shell each own entries', () => {
    const p = proxyEnv({
      HTTP_PROXY: 'http://proxy.corp:3128',
      NO_PROXY: '.corp.internal',
      no_proxy: '10.0.0.0/8,api', // the compose-merged service list the old pick() silently dropped
    } as unknown as NodeJS.ProcessEnv)
    expect(p.noProxy).toBe('.corp.internal,10.0.0.0/8,api')
  })
  it('keeps single-spelling behavior unchanged', () => {
    expect(proxyEnv({ no_proxy: 'api' } as unknown as NodeJS.ProcessEnv).noProxy).toBe('api')
    expect(proxyEnv({} as unknown as NodeJS.ProcessEnv).noProxy).toBeUndefined()
  })
})
