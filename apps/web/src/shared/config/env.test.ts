import { afterEach, describe, expect, it, vi } from 'vitest'

// The login gate's switch. This file exists because the gate used to be an INFERENCE — `keycloakConfigured`
// was exactly `ISSUER && CLIENT_ID`, so the presence of two configuration values decided a policy.
//
// The failure that bought it: `deploy/compose` starts Keycloak only under `--profile auth`, while the web
// reads those variables on every profile. An `.env` still carrying them (auth was tried once, or the template
// filled them in) made `middleware.ts` redirect every workspace URL to a login page whose server was not
// running — a locked door with no key, no error, and nothing on screen naming the missing half. The control
// plane behind it was open the whole time (`EVERDICT_REQUIRE_AUTH` unset).

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) vi.stubEnv(k, '')
    else vi.stubEnv(k, v)
  }
  return import('./env')
}

const KEYCLOAK = {
  KEYCLOAK_ISSUER: 'http://localhost:8081/realms/everdict',
  KEYCLOAK_CLIENT_ID: 'everdict-web',
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('keycloakConfigured', () => {
  it('is on when an issuer and a client id are configured', async () => {
    const { keycloakConfigured } = await loadEnv({ ...KEYCLOAK, EVERDICT_AUTH: undefined })
    expect(keycloakConfigured).toBe(true)
  })

  // Fail-closed: a deployment that never heard of this variable keeps the behaviour it had.
  it('stays on when EVERDICT_AUTH is absent, and when it says on', async () => {
    const absent = await loadEnv({ ...KEYCLOAK, EVERDICT_AUTH: undefined })
    expect(absent.keycloakConfigured).toBe(true)
    const stated = await loadEnv({ ...KEYCLOAK, EVERDICT_AUTH: 'on' })
    expect(stated.keycloakConfigured).toBe(true)
  })

  // The whole point: the values stay in place and the gate comes down, so turning auth off does not mean
  // deleting the configuration you will want back.
  it('is off when EVERDICT_AUTH says off, WITHOUT the Keycloak values being removed', async () => {
    const { env, keycloakConfigured } = await loadEnv({ ...KEYCLOAK, EVERDICT_AUTH: 'off' })
    expect(keycloakConfigured).toBe(false)
    expect(env.KEYCLOAK_ISSUER).toBe(KEYCLOAK.KEYCLOAK_ISSUER)
    expect(env.KEYCLOAK_CLIENT_ID).toBe(KEYCLOAK.KEYCLOAK_CLIENT_ID)
  })

  it('is off when nothing is configured at all — the dev default', async () => {
    const { keycloakConfigured } = await loadEnv({
      KEYCLOAK_ISSUER: undefined,
      KEYCLOAK_CLIENT_ID: undefined,
      EVERDICT_AUTH: undefined,
    })
    expect(keycloakConfigured).toBe(false)
  })

  // A typo must not read as "off". `off` is the only word that lowers the gate; anything else is refused at
  // the boundary rather than silently taken as one side or the other.
  it('refuses a value that is neither on nor off', async () => {
    await expect(loadEnv({ ...KEYCLOAK, EVERDICT_AUTH: 'disabled' })).rejects.toThrow()
  })
})
