import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { shouldBypassProxy } from './no-proxy'

// The entry-shape × candidate-host table (downstream report 4.1). The same grammar the contracts matcher
// states — CIDR, bare prefix, dot suffix, exact, star, ports, malformed-matches-nothing — asserted against
// the WEB mirror, because this is the implementation the web server actually routes with.
describe('shouldBypassProxy (web mirror) — the operator grammar, not the transport dialect', () => {
  const table: Array<{ entry: string; host: string; bypass: boolean }> = [
    { entry: '10.0.0.0/8', host: 'http://10.1.2.3:8080', bypass: true }, // CIDR — the form undici ignores
    { entry: '10.0.0.0/8', host: 'http://11.0.0.1', bypass: false },
    { entry: '192.168.', host: '192.168.7.9', bypass: true }, // bare prefix
    { entry: '192.168.', host: '192.169.0.1', bypass: false },
    { entry: '.internal', host: 'https://mlflow.corp.internal', bypass: true }, // dot suffix
    { entry: 'internal', host: 'internal', bypass: true }, // exact, suffix spelled bare
    { entry: '*', host: 'https://anything.example', bypass: true },
    { entry: 'jaeger:16686', host: 'http://jaeger:16686/api', bypass: false }, // entry with a port is not a host grammar we widen
    { entry: '10.0.0.0/', host: '10.0.0.1', bypass: false }, // malformed CIDR matches NOTHING (a typo must not widen)
  ]
  for (const { entry, host, bypass } of table) {
    it(`entry "${entry}" × host "${host}" → ${bypass ? 'bypass' : 'proxy'}`, () => {
      expect(shouldBypassProxy(host, entry)).toBe(bypass)
    })
  }
})

// ── THE DRIFT GUARD ─────────────────────────────────────────────────────────────────────────────────
//
// The web cannot import the contracts matcher at runtime (type-only rule), so it carries a mirror — and a
// mirror that can drift is the exact failure the contracts adoption exists to prevent. This compares the
// two sources with comments/whitespace stripped: any logic change on either side fails HERE until the
// other side is re-copied.
describe('the mirror is byte-identical to the contracts matcher (logic, not comments)', () => {
  const strip = (src: string): string =>
    src
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim()
  it('web copy ≡ packages/contracts/src/infra/no-proxy.ts', () => {
    const contractsSrc = readFileSync(
      join(__dirname, '../../../../../packages/contracts/src/infra/no-proxy.ts'),
      'utf8'
    )
    const webSrc = readFileSync(join(__dirname, 'no-proxy.ts'), 'utf8')
    const logicOf = (src: string): string =>
      strip(src.slice(src.indexOf('export function shouldBypassProxy')))
    expect(logicOf(webSrc)).toBe(logicOf(contractsSrc))
  })
})
