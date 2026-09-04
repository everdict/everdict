import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import en from '../../../../messages/en.json'

// These are SERVER components, so `getTranslations` has no client provider to read from. The stand-in
// resolves against the real catalog rather than echoing the key — a test that passed on the key would go on
// passing after the message was deleted.
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const table = (en as Record<string, Record<string, unknown>>)[ns] ?? {}
    return (key: string, values?: Record<string, unknown>) => {
      const raw = table[key]
      if (typeof raw !== 'string') throw new Error(`no message ${ns}.${key}`)
      return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(values?.[k] ?? ''))
    }
  },
}))
import { HarnessDelegatePanel, HarnessLineagePanel, HarnessSpanMappingPanel } from './harness-lineage-panel'

// ── AN UNREAD ANSWER IS NOT AN EMPTY ONE ───────────────────────────────────────────────────────────
//
// Every panel in this batch loads best-effort, because a failed side read must not take a detail page down
// with it. That makes the SAME mistake available to all of them: drawing nothing on a failed read tells a
// reader the thing does not exist. Census slice 5.
// docs/architecture/web-runtime-gap-census-spec.md

const render = async (node: React.ReactNode) => renderToStaticMarkup(node)

describe('harness provenance panels', () => {
  it('says the lineage could not be READ rather than drawing an empty chain', async () => {
    expect(await render(await HarnessLineagePanel({ lineage: undefined }))).toContain(
      en.harnessesPage.lineageUnread
    )
  })

  it('shows a version with its predecessor AND where that answer came from', async () => {
    // The route resolves a predecessor from the origin stamp when there is one and falls back to version
    // order otherwise. Printing the value without the source would present a fallback as a record.
    const html = await render(
      await HarnessLineagePanel({
        lineage: { versions: [{ version: '1.2.0', predecessor: '1.1.0', predecessorSource: 'order' }] },
      })
    )
    expect(html).toContain('1.1.0')
    expect(html).toContain('order')
  })

  it('distinguishes "no mapping declared" from "the mapping could not be read"', async () => {
    // Empty is a real answer here — the defaults apply. Unread is not, and a panel that drew both the same
    // way would tell somebody their spans map by default when nobody checked.
    expect(await render(await HarnessSpanMappingPanel({ mapping: { mapping: {} } }))).toContain(
      en.harnessesPage.spanMappingDefault
    )
    expect(await render(await HarnessSpanMappingPanel({ mapping: undefined }))).toContain(
      en.harnessesPage.spanMappingUnread
    )
  })

  it('names a slot with NO declared maintainer instead of printing a blank', async () => {
    // An evolution driver has nobody to ask for that slot, and a blank cell hides exactly that.
    const html = await render(await HarnessDelegatePanel({ delegate: { slots: [{ slot: 'agent' }] } }))
    expect(html).toContain(en.harnessesPage.noMaintainer)
  })
})
